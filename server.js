const express = require('express');
const { randomUUID } = require('crypto');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const rounds = require('./data/questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 10000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e6,
});

const MAX_PLAYERS = 30;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      const family = typeof net.family === 'string' ? net.family : String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

function getJoinInfo() {
  const port = PORT;
  const lan = getLanAddresses();
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const bases = publicUrl
    ? [publicUrl]
    : [`http://localhost:${port}`, ...lan.map((ip) => `http://${ip}:${port}`)];
  return {
    port,
    lan,
    publicUrl: publicUrl || null,
    playerUrls: bases.map((base) => `${base}/player.html`),
    hostUrls: bases.map((base) => `${base}/host.html`),
  };
}

app.get('/api/network', (_req, res) => {
  res.json(getJoinInfo());
});

app.get('/api/qr', async (req, res) => {
  const url = String(req.query.url || '');
  const allowed = getJoinInfo().playerUrls;
  const ok =
    allowed.includes(url) ||
    /^https?:\/\/[^\s]+\/player\.html$/i.test(url);
  if (!ok) {
    res.status(400).send('Bad url');
    return;
  }
  try {
    const png = await QRCode.toBuffer(url, {
      type: 'png',
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0a', light: '#ffffff' },
    });
    res.set('Cache-Control', 'no-store');
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('QR error');
  }
});

function normalize(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:°]/g, '');
}

function checkAnswer(userAnswer, question) {
  if (!userAnswer || !userAnswer.trim()) return 'empty';
  const normalized = normalize(userAnswer);
  const accepted = question.answers.map(normalize);
  if (accepted.some((a) => normalized === a || normalized.includes(a) || a.includes(normalized))) {
    return 'correct';
  }
  return 'wrong';
}

function getDisplayAnswer(question) {
  if (question.displayAnswer) return question.displayAnswer;
  return question.answers[0].charAt(0).toUpperCase() + question.answers[0].slice(1);
}

function createInitialState() {
  return {
    phase: 'registration',
    roundIndex: 0,
    questionIndex: 0,
    isReview: false,
    timeLeft: 0,
    players: [],
    answers: {},
    timerId: null,
    hostConnected: false,
  };
}

let game = createInitialState();
let hostSocketId = null;

function getPublicState() {
  const round = rounds[game.roundIndex];
  const question = round?.questions[game.questionIndex];

  return {
    phase: game.phase,
    roundIndex: game.roundIndex,
    questionIndex: game.questionIndex,
    isReview: game.isReview,
    timeLeft: game.timeLeft,
    players: game.players.map((p) => ({ uid: p.uid, name: p.name, score: p.score })),
    roundName: round?.name ?? '',
    roundDescription: round?.description ?? '',
    questionText: question?.text ?? '',
    correctAnswer: game.isReview && question ? getDisplayAnswer(question) : null,
    questionTime: round?.questionTime ?? 30,
    reviewTime: round?.reviewTime ?? 3,
    totalRounds: rounds.length,
    totalQuestions: round?.questions.length ?? 0,
    playerCount: game.players.length,
    maxPlayers: MAX_PLAYERS,
    hostConnected: game.hostConnected,
    join: getJoinInfo(),
  };
}

function broadcastState() {
  io.emit('state', getPublicState());
}

function clearTimer() {
  if (game.timerId) {
    clearInterval(game.timerId);
    game.timerId = null;
  }
}

function scoreAnswers() {
  const round = rounds[game.roundIndex];
  const question = round.questions[game.questionIndex];
  const scoring = round.scoring;

  for (const player of game.players) {
    const raw = game.answers[player.uid] ?? '';
    const result = checkAnswer(raw, question);
    let points = 0;
    if (result === 'correct') points = scoring.correct;
    else if (result === 'wrong') points = scoring.wrong;
    else points = scoring.empty;
    player.score += points;
    player.lastResult = { result, points, answer: raw };
    if (player.socketId) {
      io.to(player.socketId).emit('questionResult', {
        ...player.lastResult,
        correctAnswer: getDisplayAnswer(question),
      });
    }
  }
}

function startTimer(duration, onEnd) {
  clearTimer();
  game.timeLeft = duration;
  broadcastState();

  game.timerId = setInterval(() => {
    game.timeLeft -= 1;
    io.emit('tick', game.timeLeft);

    if (game.timeLeft <= 0) {
      clearTimer();
      onEnd();
    }
  }, 1000);
}

function showQuestion() {
  game.phase = 'playing';
  game.isReview = false;
  game.answers = {};
  for (const p of game.players) p.lastResult = null;

  const round = rounds[game.roundIndex];
  const duration = round.questionTime;
  startTimer(duration, () => {
    scoreAnswers();
    const round = rounds[game.roundIndex];
    if (round.hasReview) {
      startReview();
    } else if (game.questionIndex < round.questions.length - 1) {
      game.questionIndex += 1;
      showQuestion();
    } else if (game.roundIndex < rounds.length - 1) {
      game.phase = 'roundBreak';
      broadcastState();
    } else {
      finishGame();
    }
  });
  broadcastState();
}

function startReview() {
  game.isReview = true;
  game.phase = 'review';
  const round = rounds[game.roundIndex];
  startTimer(round.reviewTime, () => {
    if (game.questionIndex < round.questions.length - 1) {
      game.questionIndex += 1;
      showQuestion();
    } else if (game.roundIndex < rounds.length - 1) {
      game.phase = 'roundBreak';
      game.isReview = false;
      broadcastState();
    } else {
      finishGame();
    }
  });
  broadcastState();
}

function finishGame() {
  clearTimer();
  game.phase = 'finished';
  game.isReview = false;
  game.players.sort((a, b) => b.score - a.score);
  broadcastState();
}

function getLeaderboard() {
  const sorted = [...game.players].sort((a, b) => b.score - a.score);
  return sorted.map((p, i) => ({
    rank: i + 1,
    uid: p.uid,
    name: p.name,
    score: p.score,
    message:
      i < 3
        ? 'Подойдите к ведущему за призом'
        : 'Спасибо огромное за участие! Надеемся, вам было с нами интересно!',
  }));
}

function attachPlayerSocket(player, socket) {
  player.socketId = socket.id;
  socket.join('players');
}

function findPlayerByUid(uid) {
  return game.players.find((p) => p.uid === uid);
}

io.on('connection', (socket) => {
  socket.emit('state', getPublicState());

  socket.on('host:join', () => {
    socket.join('host');
    hostSocketId = socket.id;
    game.hostConnected = true;
    broadcastState();
  });

  socket.on('player:register', ({ name }) => {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('error', 'Введите имя');
      return;
    }
    if (game.phase !== 'registration') {
      socket.emit('error', 'Регистрация уже закрыта');
      return;
    }
    if (game.players.length >= MAX_PLAYERS) {
      socket.emit('error', `Достигнут лимит участников (${MAX_PLAYERS})`);
      return;
    }
    if (game.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('error', 'Такое имя уже занято');
      return;
    }

    const player = {
      uid: randomUUID(),
      socketId: socket.id,
      name: trimmed,
      score: 0,
      lastResult: null,
      socialBonus: false,
    };
    game.players.push(player);
    attachPlayerSocket(player, socket);
    socket.emit('registered', { uid: player.uid, name: player.name });
    broadcastState();
  });

  socket.on('player:rejoin', ({ uid }) => {
    const player = findPlayerByUid(uid);
    if (player) {
      attachPlayerSocket(player, socket);
      socket.emit('registered', { uid: player.uid, name: player.name });
      if (game.phase === 'finished') {
        socket.emit('leaderboard', getLeaderboard());
      }
      broadcastState();
    }
  });

  socket.on('player:answer', ({ uid, answer }) => {
    if (game.phase !== 'playing' || game.isReview) return;
    const player = findPlayerByUid(uid);
    if (!player || player.socketId !== socket.id) return;
    game.answers[player.uid] = answer ?? '';
  });

  socket.on('player:socialBonus', ({ uid }) => {
    const player = findPlayerByUid(uid);
    if (!player || player.socketId !== socket.id) return;
    if (player.socialBonus) {
      socket.emit('socialBonus', { awarded: false, already: true, score: player.score });
      return;
    }
    player.socialBonus = true;
    player.score += 1;
    socket.emit('socialBonus', { awarded: true, points: 1, score: player.score });
    broadcastState();
  });

  socket.on('host:start', () => {
    if (game.players.length === 0) return;
    game.roundIndex = 0;
    game.questionIndex = 0;
    showQuestion();
  });

  socket.on('host:nextRound', () => {
    if (game.phase !== 'roundBreak') return;
    game.roundIndex += 1;
    game.questionIndex = 0;
    showQuestion();
  });

  socket.on('host:reset', () => {
    clearTimer();
    game = createInitialState();
    game.hostConnected = true;
    io.emit('game:reset');
    broadcastState();
  });

  socket.on('host:adjustScore', ({ uid, delta }) => {
    if (socket.id !== hostSocketId) return;
    const player = findPlayerByUid(uid);
    const change = Number(delta);
    if (!player || !Number.isInteger(change) || change === 0) return;
    player.score += change;
    broadcastState();
  });

  socket.on('get:leaderboard', () => {
    socket.emit('leaderboard', getLeaderboard());
  });

  socket.on('disconnect', () => {
    if (socket.id === hostSocketId) {
      game.hostConnected = false;
      hostSocketId = null;
    }
    broadcastState();
  });
});

server.listen(PORT, HOST, () => {
  const info = getJoinInfo();
  console.log(`Quiz Times запущен на ${HOST}:${PORT}`);
  console.log(`Локально:  http://localhost:${PORT}`);
  console.log(`Ведущий:   http://localhost:${PORT}/host.html`);
  console.log(`Игрок:     http://localhost:${PORT}/player.html`);
  if (info.lan.length) {
    console.log('В локальной сети (точка доступа / Wi‑Fi):');
    for (const url of info.playerUrls.filter((u) => !u.includes('localhost'))) {
      console.log(`  ${url}`);
    }
  } else {
    console.log('LAN-адрес не найден. Включите Wi‑Fi или точку доступа и перезапустите сервер.');
  }
});
