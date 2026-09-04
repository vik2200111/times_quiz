const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
});

const STORAGE_KEY = 'quiz_player';

const screens = {
  register: document.getElementById('screen-register'),
  waiting: document.getElementById('screen-waiting'),
  playing: document.getElementById('screen-playing'),
  review: document.getElementById('screen-review'),
  roundBreak: document.getElementById('screen-round-break'),
  finished: document.getElementById('screen-finished'),
};

const els = {
  registerForm: document.getElementById('register-form'),
  nameInput: document.getElementById('name-input'),
  registerError: document.getElementById('register-error'),
  playerName: document.getElementById('player-name'),
  playingName: document.getElementById('playing-name'),
  roundLabel: document.getElementById('round-label'),
  timer: document.getElementById('timer'),
  questionText: document.getElementById('question-text'),
  answerForm: document.getElementById('answer-form'),
  answerInput: document.getElementById('answer-input'),
  resultFlash: document.getElementById('result-flash'),
  reviewTimer: document.getElementById('review-timer'),
  reviewQuestion: document.getElementById('review-question'),
  reviewAnswer: document.getElementById('review-answer'),
  reviewResult: document.getElementById('review-result'),
  breakScore: document.getElementById('break-score'),
  leaderboardBody: document.getElementById('leaderboard-body'),
  prizeMessage: document.getElementById('prize-message'),
  socialBar: document.getElementById('social-bar'),
  socialClose: document.getElementById('social-close'),
  socialBonus: document.getElementById('social-bonus'),
  btnOk: document.getElementById('btn-ok'),
  answerStatus: document.getElementById('answer-status'),
};

let playerUid = null;
let playerName = null;
let currentState = null;
let myScore = 0;
let lastQuestionKey = '';
let socialShownForQuestion = '';
let socialTimer = null;
let socialCheckTimer = null;
let answerLocked = false;

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  if (screens[name]) screens[name].classList.remove('hidden');
}

function showError(msg) {
  els.registerError.textContent = msg;
  els.registerError.classList.remove('hidden');
}

function hideError() {
  els.registerError.classList.add('hidden');
}

function updateTimer(el, seconds, maxSeconds) {
  el.textContent = seconds;
  el.classList.remove('warning', 'danger');
  const threshold = maxSeconds <= 20 ? 5 : 10;
  if (seconds <= threshold / 2) el.classList.add('danger');
  else if (seconds <= threshold) el.classList.add('warning');
  document.querySelectorAll('.equalizer span').forEach((bar, i) => {
    const ratio = maxSeconds ? seconds / maxSeconds : 0;
    const wave = Math.abs(Math.sin((i + 1) * 0.9 + ratio * 6));
    bar.style.height = `${8 + wave * ratio * 24}px`;
  });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function savePlayer() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: playerUid, name: playerName }));
}

function sendAnswer() {
  if (!playerUid || currentState?.phase !== 'playing' || currentState?.isReview) return;
  socket.emit('player:answer', { uid: playerUid, answer: els.answerInput.value });
}

function confirmAnswer() {
  if (!playerUid || currentState?.phase !== 'playing' || currentState?.isReview || answerLocked) return;
  sendAnswer();
  answerLocked = true;
  els.answerInput.disabled = true;
  if (els.btnOk) els.btnOk.disabled = true;
  els.answerStatus?.classList.remove('hidden');
  maybeShowSocialBar();
}

function unlockAnswer() {
  answerLocked = false;
  if (els.answerInput) {
    els.answerInput.disabled = false;
    els.answerInput.value = '';
  }
  if (els.btnOk) els.btnOk.disabled = false;
  els.answerStatus?.classList.add('hidden');
  els.resultFlash?.classList.add('hidden');
}

function resetPlayerSession() {
  playerUid = null;
  playerName = null;
  myScore = 0;
  lastQuestionKey = '';
  socialShownForQuestion = '';
  answerLocked = false;
  localStorage.removeItem(STORAGE_KEY);
  hideSocialBar();
  hideError();
  if (els.nameInput) els.nameInput.value = '';
  unlockAnswer();
  showScreen('register');
}

function hideSocialBar() {
  if (!els.socialBar) return;
  els.socialBar.classList.add('hidden');
  document.body.classList.remove('has-social-bar');
  if (socialTimer) {
    clearTimeout(socialTimer);
    socialTimer = null;
  }
}

function maybeShowSocialBar() {
  const answer = (els.answerInput?.value || '').trim();
  if (answer.length < 2 || !els.socialBar) return;
  const qKey = lastQuestionKey || `${currentState?.roundIndex}-${currentState?.questionIndex}`;
  if (socialShownForQuestion === qKey) return;
  if (socialCheckTimer) clearTimeout(socialCheckTimer);
  socialCheckTimer = setTimeout(() => {
    if (socialShownForQuestion === qKey) return;
    socialShownForQuestion = qKey;
    if (Math.random() > 0.45) return;
    els.socialBar.classList.remove('hidden');
    document.body.classList.add('has-social-bar');
    els.socialBonus?.classList.add('hidden');
    if (socialTimer) clearTimeout(socialTimer);
    socialTimer = setTimeout(hideSocialBar, 16000);
  }, 800);
}

function tryRejoin() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const { uid } = JSON.parse(saved);
    if (uid) socket.emit('player:rejoin', { uid });
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

els.registerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();
  const name = els.nameInput.value.trim();
  if (!name) {
    showError('Введите имя');
    return;
  }
  socket.emit('player:register', { name });
});

els.answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  confirmAnswer();
});

socket.on('connect', () => {
  tryRejoin();
});

socket.on('registered', ({ uid, name }) => {
  playerUid = uid;
  playerName = name;
  savePlayer();
  els.playerName.textContent = name;
  els.playingName.textContent = name;
  showScreen('waiting');
});

socket.on('error', (msg) => {
  showError(msg);
});

socket.on('state', (state) => {
  currentState = state;

  if (state.phase === 'registration' && !playerUid) {
    showScreen('register');
    return;
  }

  if (!playerUid) return;

  const me = state.players.find((p) => p.uid === playerUid || p.name === playerName);
  if (me) {
    playerUid = me.uid;
    myScore = me.score;
  } else if (state.phase === 'registration') {
    resetPlayerSession();
    return;
  }

  switch (state.phase) {
    case 'registration':
      if (playerName) showScreen('waiting');
      break;

    case 'playing':
      if (state.isReview) {
        showReview(state);
      } else {
        showScreen('playing');
        els.roundLabel.textContent = `Тур ${state.roundIndex + 1}: ${state.roundName} — Вопрос ${state.questionIndex + 1}/${state.totalQuestions}`;
        els.questionText.textContent = state.questionText;
        updateTimer(els.timer, state.timeLeft, state.questionTime || (state.roundIndex === 3 ? 15 : 30));

        const qKey = `${state.roundIndex}-${state.questionIndex}`;
        if (qKey !== lastQuestionKey) {
          lastQuestionKey = qKey;
          unlockAnswer();
          hideSocialBar();
        }
      }
      break;

    case 'review':
      showReview(state);
      break;

    case 'roundBreak':
      showScreen('roundBreak');
      els.breakScore.textContent = myScore;
      break;

    case 'finished':
      showScreen('finished');
      socket.emit('get:leaderboard');
      break;
  }
});

function showReview(state) {
  showScreen('review');
  els.reviewQuestion.textContent = state.questionText;
  updateTimer(els.reviewTimer, state.timeLeft, state.reviewTime || 3);
  els.answerInput.disabled = true;
  if (els.btnOk) els.btnOk.disabled = true;
  if (state.correctAnswer) {
    els.reviewAnswer.textContent = `Ответ: ${state.correctAnswer}`;
    els.reviewAnswer.classList.remove('hidden');
  } else if (els.reviewAnswer) {
    els.reviewAnswer.classList.add('hidden');
  }
}

socket.on('tick', (timeLeft) => {
  if (!currentState) return;
  if (currentState.isReview || currentState.phase === 'review') {
    updateTimer(els.reviewTimer, timeLeft, currentState.reviewTime || 3);
  } else if (currentState.phase === 'playing') {
    updateTimer(els.timer, timeLeft, currentState.questionTime || (currentState.roundIndex === 3 ? 15 : 30));
    if (timeLeft <= 1) sendAnswer();
  }
});

socket.on('questionResult', (result) => {
  const labels = {
    correct: `Верно! +${result.points} ${result.points === 1 ? 'балл' : 'балла'}`,
    wrong: result.points < 0 ? `Неверно. ${result.points} балл` : 'Неверно',
    empty: 'Без ответа',
  };
  const text = labels[result.result] || '';
  for (const el of [els.resultFlash, els.reviewResult]) {
    if (!el) continue;
    el.textContent = text;
    el.classList.remove('hidden', 'correct', 'wrong', 'empty');
    el.classList.add(result.result);
  }
  if (result.correctAnswer && els.reviewAnswer) {
    els.reviewAnswer.textContent = `Ответ: ${result.correctAnswer}`;
    els.reviewAnswer.classList.remove('hidden');
  }
});

socket.on('leaderboard', (board) => {
  els.leaderboardBody.innerHTML = board
    .map(
      (entry) =>
        `<tr class="${entry.rank <= 3 ? 'top3' : ''}">
          <td class="rank">${entry.rank}</td>
          <td>${escapeHtml(entry.name)}</td>
          <td class="score-col">${entry.score}</td>
        </tr>`
    )
    .join('');

  const me = board.find((e) => e.name === playerName);
  if (me) {
    els.prizeMessage.textContent = me.message;
    els.prizeMessage.classList.remove('hidden', 'winner', 'participant');
    els.prizeMessage.classList.add(me.rank <= 3 ? 'winner' : 'participant');
  }
});

tryRejoin();

els.socialClose?.addEventListener('click', hideSocialBar);

els.socialBar?.addEventListener('click', (e) => {
  if (!e.target.closest('.social-link') || !playerUid) return;
  socket.emit('player:socialBonus', { uid: playerUid });
});

socket.on('socialBonus', ({ awarded, score }) => {
  if (typeof score === 'number') myScore = score;
  if (awarded && els.socialBonus) {
    els.socialBonus.classList.remove('hidden');
  }
});

socket.on('game:reset', () => {
  resetPlayerSession();
});
