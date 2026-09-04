const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
});

const screens = {
  registration: document.getElementById('screen-registration'),
  playing: document.getElementById('screen-playing'),
  roundBreak: document.getElementById('screen-round-break'),
  finished: document.getElementById('screen-finished'),
};

const els = {
  statusText: document.getElementById('status-text'),
  phaseBadge: document.getElementById('phase-badge'),
  playersList: document.getElementById('players-list'),
  playerCount: document.getElementById('player-count'),
  btnStart: document.getElementById('btn-start'),
  btnRestart: document.getElementById('btn-restart'),
  btnResetFinish: document.getElementById('btn-reset-finish'),
  btnNextRound: document.getElementById('btn-next-round'),
  roundInfo: document.getElementById('round-info'),
  progressFill: document.getElementById('progress-fill'),
  timer: document.getElementById('timer'),
  questionText: document.getElementById('question-text'),
  answerReveal: document.getElementById('answer-reveal'),
  roundBreakTitle: document.getElementById('round-break-title'),
  roundBreakDesc: document.getElementById('round-break-desc'),
  leaderboardBody: document.getElementById('leaderboard-body'),
  scoresList: document.getElementById('scores-list'),
  equalizer: document.getElementById('equalizer'),
  playingWindowTitle: document.getElementById('playing-window-title'),
  joinUrl: document.getElementById('join-url'),
  joinQr: document.getElementById('join-qr'),
  btnCopyLink: document.getElementById('btn-copy-link'),
};

let currentState = null;

socket.on('connect', () => {
  socket.emit('host:join');
});

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  if (screens[name]) screens[name].classList.remove('hidden');
}

function updateEqualizer(seconds, maxSeconds) {
  if (!els.equalizer) return;
  const bars = els.equalizer.querySelectorAll('span');
  const ratio = maxSeconds ? seconds / maxSeconds : 0;
  bars.forEach((bar, i) => {
    const wave = Math.abs(Math.sin((i + 1) * 0.9 + ratio * 6));
    const height = 8 + wave * ratio * 24;
    bar.style.height = `${height}px`;
    bar.style.opacity = ratio > 0.15 ? '1' : '0.35';
  });
}

function updateTimer(el, seconds, maxSeconds) {
  el.textContent = seconds;
  el.classList.remove('warning', 'danger');
  const threshold = maxSeconds <= 20 ? 5 : 10;
  if (seconds <= threshold / 2) el.classList.add('danger');
  else if (seconds <= threshold) el.classList.add('warning');
  updateEqualizer(seconds, maxSeconds);
}

function playerRow(p, withControls) {
  const controls = withControls
    ? `<div class="score-controls">
        <button type="button" class="score-btn minus" data-uid="${p.uid}" data-delta="-1" aria-label="Минус балл">−</button>
        <span class="score">${p.score}</span>
        <button type="button" class="score-btn plus" data-uid="${p.uid}" data-delta="1" aria-label="Плюс балл">+</button>
      </div>`
    : `<span class="score">${p.score}</span>`;
  return `<div class="player-chip host-row">
    <span class="chip-name">${escapeHtml(p.name)}</span>
    ${controls}
  </div>`;
}

function renderPlayers(players, maxPlayers) {
  els.playersList.innerHTML = players.map((p) => playerRow(p, true)).join('');
  els.playerCount.textContent = `${players.length} / ${maxPlayers || 30} участников`;
}

function renderScores(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  els.scoresList.innerHTML = sorted.map((p) => playerRow(p, true)).join('');
}

function renderLeaderboard(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  els.leaderboardBody.innerHTML = sorted
    .map(
      (p, i) =>
        `<tr class="${i < 3 ? 'top3' : ''}">
          <td class="rank">${i + 1}</td>
          <td>${escapeHtml(p.name)}</td>
          <td class="score-col">${p.score}</td>
        </tr>`
    )
    .join('');
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function pickJoinUrl(state) {
  const urls = state?.join?.playerUrls || [];
  const lan = urls.find((u) => !u.includes('localhost'));
  return lan || urls[0] || `${location.origin}/player.html`;
}

function updateJoinCard(state) {
  if (!els.joinUrl) return;
  const url = pickJoinUrl(state);
  els.joinUrl.textContent = url;
  if (els.joinQr) {
    els.joinQr.src = `/api/qr?url=${encodeURIComponent(url)}`;
  }
}

function handleState(state) {
  currentState = state;
  renderScores(state.players);
  updateJoinCard(state);

  const phaseLabels = {
    registration: 'Регистрация',
    playing: state.isReview ? 'Правильный ответ' : 'Вопрос',
    review: 'Правильный ответ',
    roundBreak: 'Перерыв между турами',
    finished: 'Игра завершена',
  };

  els.phaseBadge.textContent = phaseLabels[state.phase] || state.phase;
  const badgeClass = state.isReview
    ? 'review'
    : state.phase === 'playing'
      ? 'playing'
      : state.phase === 'registration'
        ? 'registration'
        : '';
  els.phaseBadge.className = badgeClass ? `badge ${badgeClass}` : 'badge';

  switch (state.phase) {
    case 'registration':
      showScreen('registration');
      renderPlayers(state.players, state.maxPlayers);
      els.btnStart.disabled = state.players.length === 0;
      els.statusText.textContent = 'Ожидание регистрации участников';
      break;

    case 'playing':
    case 'review':
      showScreen('playing');
      if (els.playingWindowTitle) {
        els.playingWindowTitle.textContent = state.isReview ? 'Правильный ответ' : 'Вопрос';
      }
      els.roundInfo.textContent = `Тур ${state.roundIndex + 1}: ${state.roundName} — Вопрос ${state.questionIndex + 1} из ${state.totalQuestions}`;
      els.questionText.textContent = state.questionText;

      const maxTime = state.isReview ? (state.reviewTime || 3) : (state.questionTime || (state.roundIndex === 3 ? 15 : 30));
      updateTimer(els.timer, state.timeLeft, maxTime);

      const progress =
        ((state.questionIndex + (state.isReview ? 0.5 : 0)) / state.totalQuestions) * 100;
      els.progressFill.style.width = `${progress}%`;

      if (state.isReview && state.correctAnswer) {
        els.answerReveal.textContent = `Ответ: ${state.correctAnswer}`;
        els.answerReveal.classList.remove('hidden');
      } else {
        els.answerReveal.classList.add('hidden');
      }

      els.statusText.textContent = state.isReview
        ? 'Правильный ответ'
        : `Тур ${state.roundIndex + 1}, вопрос ${state.questionIndex + 1}`;
      break;

    case 'roundBreak':
      showScreen('roundBreak');
      els.roundBreakTitle.textContent = `Тур «${state.roundName}» завершён`;
      const nextRound = state.roundIndex + 2;
      els.roundBreakDesc.textContent =
        nextRound <= state.totalRounds
          ? `Нажмите «Следующий тур» для начала тура ${nextRound}`
          : '';
      els.statusText.textContent = 'Перерыв между турами';
      break;

    case 'finished':
      showScreen('finished');
      renderLeaderboard(state.players);
      els.statusText.textContent = 'Квиз завершён';
      break;
  }
}

function onScoreClick(e) {
  const btn = e.target.closest('.score-btn');
  if (!btn) return;
  const uid = btn.dataset.uid;
  const delta = Number(btn.dataset.delta);
  if (!uid || !delta) return;
  socket.emit('host:adjustScore', { uid, delta });
}

els.playersList.addEventListener('click', onScoreClick);
els.scoresList.addEventListener('click', onScoreClick);

els.btnCopyLink.addEventListener('click', async () => {
  const url = els.joinUrl.textContent.trim();
  try {
    await navigator.clipboard.writeText(url);
    els.btnCopyLink.textContent = 'Скопировано';
    setTimeout(() => {
      els.btnCopyLink.textContent = 'Копировать';
    }, 1500);
  } catch {
    prompt('Скопируйте ссылку:', url);
  }
});

socket.on('state', handleState);

socket.on('tick', (timeLeft) => {
  if (!currentState) return;
  const maxTime = currentState.isReview
    ? (currentState.reviewTime || 3)
    : (currentState.questionTime || (currentState.roundIndex === 3 ? 15 : 30));
  updateTimer(els.timer, timeLeft, maxTime);
});

function restartQuiz() {
  if (confirm('Начать квиз заново? Все участники и баллы будут сброшены, нужна новая регистрация.')) {
    socket.emit('host:reset');
  }
}

els.btnStart.addEventListener('click', () => socket.emit('host:start'));
els.btnNextRound.addEventListener('click', () => socket.emit('host:nextRound'));
els.btnRestart.addEventListener('click', restartQuiz);
els.btnResetFinish.addEventListener('click', restartQuiz);
