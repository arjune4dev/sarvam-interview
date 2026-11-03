const toast = document.getElementById('toast');
let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

const voiceModal = document.getElementById('voiceModal');
const startVoice = document.getElementById('startVoice');
const recordAnswer = document.getElementById('recordAnswer');
const endVoice = document.getElementById('endVoice');
const voiceStatus = document.getElementById('voiceStatus');
const voiceHint = document.getElementById('voiceHint');
const transcript = document.getElementById('transcript');
let listening = false;
let transcriptText = '';
let conversationTranscript = '';
let turnHistory = [];
let micStream;
let recorder;
let audioChunks = [];
let recordingTimer;
let speechPlayer;
let candidates = [];
let reviewCandidate = null;
const candidateRows = document.getElementById('candidateRows');
const candidateModal = document.getElementById('candidateModal');
const voiceCandidate = document.getElementById('voiceCandidate');

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function initials(name) {
  return String(name || 'C').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
}
function stageClass(stage) { return `status-${String(stage || 'applied').toLowerCase().replace(/\s+/g, '-')}`; }
function scorecardHTML(raw) {
  let scorecard;
  try {
    scorecard = JSON.parse(raw);
  } catch (_) {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    try { scorecard = first >= 0 && last > first ? JSON.parse(raw.slice(first, last + 1)) : null; } catch (_) { scorecard = null; }
  }
  if (!scorecard) return `<h3>Recruiter scorecard</h3><pre>${escapeHTML(raw)}</pre>`;
  const competencies = (scorecard.competencies || []).map(item => `<li><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(item.score)}/5</span><small>${escapeHTML(item.evidence)}</small></li>`).join('');
  const list = values => (values || []).map(value => `<li>${escapeHTML(value)}</li>`).join('');
  return `<section class="scorecard-result"><div class="scorecard-title"><div><small>AI SUGGESTION · RECRUITER DECISION REQUIRED</small><h3>Suggested: ${escapeHTML(scorecard.recommendation || 'Review')}</h3></div><span>${escapeHTML(scorecard.confidence ?? '—')}% confidence</span></div><p>${escapeHTML(scorecard.summary || '')}</p><h4>Competency evidence</h4><ul class="competency-list">${competencies || '<li>Insufficient competency evidence yet.</li>'}</ul><div class="scorecard-columns"><div><h4>Strengths</h4><ul>${list(scorecard.strengths) || '<li>None recorded</li>'}</ul></div><div><h4>Evidence gaps</h4><ul>${list(scorecard.gaps) || '<li>None recorded</li>'}</ul></div></div>${scorecard.follow_up?.length ? `<h4>Suggested follow-ups</h4><ul class="follow-up-list">${list(scorecard.follow_up)}</ul>` : ''}</section>`;
}
function renderCandidates() {
  candidateRows.innerHTML = candidates.map((candidate, index) => {
    const colors = ['avatar-peach', 'avatar-blue', 'avatar-yellow'];
    const score = candidate.ai_score === null || candidate.ai_score === undefined || candidate.ai_score === '' ? null : Number(candidate.ai_score);
    return `<div class="candidate-row" data-id="${candidate.id}">
      <div class="candidate-cell"><div class="avatar ${colors[index % colors.length]}">${escapeHTML(initials(candidate.name))}</div><div><strong>${escapeHTML(candidate.name)}</strong><small>${escapeHTML(candidate.email || 'No email added')}</small></div></div>
      <div class="role-cell">${escapeHTML(candidate.role)}<small>${escapeHTML(candidate.experience || 'Profile available')}</small></div>
      <div><select class="stage-select ${stageClass(candidate.stage)}" aria-label="Recruiting stage for ${escapeHTML(candidate.name)}" data-id="${candidate.id}">${['Applied','AI interview','Recruiter review','Scheduled','Offer','Hired','Declined'].map(stage => `<option ${stage === candidate.stage ? 'selected' : ''}>${stage}</option>`).join('')}</select></div>
      <div class="score">${score === null ? '<span class="score-empty">—</span><span>Not scored</span>' : `<span class="score-ring ${score >= 70 ? 'high' : 'mid'}">${score}</span><span>Rubric avg.</span>`}</div>
      <div class="candidate-actions"><button class="row-review" aria-label="Open review for ${escapeHTML(candidate.name)}">Review</button><button class="row-more" aria-label="Draft outreach for ${escapeHTML(candidate.name)}">···</button></div>
    </div>`;
  }).join('') || '<div class="empty-candidates">No candidates yet. Add your first candidate to get started.</div>';
  const selected = voiceCandidate.value;
  voiceCandidate.innerHTML = candidates.map(candidate => `<option value="${candidate.id}">${escapeHTML(candidate.name)} · ${escapeHTML(candidate.role)}</option>`).join('');
  if (candidates.some(candidate => String(candidate.id) === selected)) voiceCandidate.value = selected;
  else if (candidates.length) voiceCandidate.value = String(candidates[0].id);
  const activeCandidate = candidates.find(candidate => String(candidate.id) === voiceCandidate.value);
  const roleSelect = document.getElementById('voiceRole');
  if (activeCandidate && [...roleSelect.options].some(option => option.value === activeCandidate.role)) roleSelect.value = activeCandidate.role;
  const scheduleCandidate = document.getElementById('scheduleCandidate');
  if (scheduleCandidate) {
    const current = scheduleCandidate.value;
    scheduleCandidate.innerHTML = candidates.map(candidate => `<option value="${candidate.id}">${escapeHTML(candidate.name)} · ${escapeHTML(candidate.role)}</option>`).join('');
    if (candidates.some(candidate => String(candidate.id) === current)) scheduleCandidate.value = current;
    else if (candidates.length) scheduleCandidate.value = String(candidates[0].id);
  }
}
async function loadCandidates() {
  try {
    const response = await fetch('/api/candidates');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load candidates');
    candidates = data.candidates;
    renderCandidates();
  } catch (error) { showToast(error.message); }
}
async function openReview(candidateId) {
  try {
    const response = await fetch(`/api/candidate?id=${encodeURIComponent(candidateId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load candidate review');
    reviewCandidate = data.candidate;
    document.getElementById('reviewTitle').textContent = reviewCandidate.name;
    const decisionMeta = reviewCandidate.human_decision && reviewCandidate.human_decision !== 'Pending recruiter decision' ? ` · Recruiter decision: ${reviewCandidate.human_decision}` : '';
    document.getElementById('reviewMeta').textContent = `${reviewCandidate.role} · ${reviewCandidate.stage}${decisionMeta} · ${reviewCandidate.email || 'No email on file'}`;
    document.getElementById('reviewScorecard').innerHTML = reviewCandidate.scorecard ? scorecardHTML(reviewCandidate.scorecard) : '<div class="no-review">No interview scorecard yet. Start a voice interview to create a structured, role-specific assessment.</div>';
    document.getElementById('reviewTranscript').textContent = reviewCandidate.transcript || 'No interview transcript saved yet.';
    document.getElementById('reviewerFeedback').value = reviewCandidate.reviewer_feedback || '';
    document.getElementById('humanDecision').value = reviewCandidate.human_decision || 'Pending recruiter decision';
    const modal = document.getElementById('reviewModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  } catch (error) { showToast(error.message); }
}
function closeReview() {
  const modal = document.getElementById('reviewModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  reviewCandidate = null;
}
async function loadInterviews() {
  const panel = document.getElementById('interviews');
  let list = document.getElementById('savedInterviews');
  if (!list) {
    list = document.createElement('div');
    list.id = 'savedInterviews';
    panel.insertBefore(list, panel.querySelector('.timeline'));
  }
  try {
    const response = await fetch('/api/interviews');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load scheduled interviews');
    list.innerHTML = data.interviews.map(item => {
      const date = new Date(item.starts_at);
      return `<div class="saved-interview"><div class="saved-date"><strong>${escapeHTML(date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</strong><small>${escapeHTML(date.toLocaleDateString([], { month: 'short', day: 'numeric' }))}</small></div><div class="saved-interview-info"><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(item.role)} · AI voice</span><small>${item.duration_minutes} min · ${escapeHTML(item.status)}</small></div></div>`;
    }).join('');
    if (!data.interviews.length) list.innerHTML = '<div class="empty-interviews">No interviews scheduled yet. Use + to add one.</div>';
  } catch (error) { showToast(error.message); }
}

function openVoiceModal() {
  voiceModal.classList.add('open');
  voiceModal.setAttribute('aria-hidden', 'false');
}
function closeVoiceModal() {
  if (listening) stopVoice();
  voiceModal.classList.remove('open');
  voiceModal.setAttribute('aria-hidden', 'true');
}
document.getElementById('voiceDemo').addEventListener('click', openVoiceModal);
document.getElementById('closeVoice').addEventListener('click', closeVoiceModal);
voiceModal.addEventListener('click', event => { if (event.target === voiceModal) closeVoiceModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeVoiceModal(); });

async function agentTurn() {
  const candidate = candidates.find(item => String(item.id) === voiceCandidate.value);
  if (!candidate) throw new Error('Choose a candidate before starting the interview.');
  const role = document.getElementById('voiceRole').value;
  const language = document.getElementById('voiceLanguage').value;
  const response = await fetch('/api/interview/turn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate: candidate.name, profile: candidate, role, language, messages: turnHistory })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Interview service returned ${response.status}`);
  turnHistory.push({ role: 'assistant', content: data.reply });
  conversationTranscript += `Interviewer: ${data.reply}\n`;
  transcript.textContent = conversationTranscript;
  await speakReply(data.reply, language);
}

async function speakReply(text, language) {
  try {
    const response = await fetch('/api/voice/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Speech synthesis failed');
    if (speechPlayer) speechPlayer.pause();
    speechPlayer = new Audio(`data:audio/wav;base64,${data.audio}`);
    await speechPlayer.play();
    await new Promise(resolve => { speechPlayer.onended = resolve; speechPlayer.onerror = resolve; });
  } catch (error) {
    // Some browsers block audio playback after the API round trip. Keep the interview usable.
    if (!window.speechSynthesis) throw error;
    await new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language;
      utterance.onend = resolve;
      utterance.onerror = resolve;
      window.speechSynthesis.speak(utterance);
    });
  }
}

function audioMimeType() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function fileAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

async function processRecording(blob, mime) {
  if (!listening || !blob.size) return;
  recordAnswer.disabled = true;
  voiceStatus.textContent = 'Transcribing your answer';
  voiceHint.textContent = 'Sarvam Saaras is processing the recording.';
  try {
    const response = await fetch('/api/voice/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: await fileAsBase64(blob), mime, language: document.getElementById('voiceLanguage').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Transcription returned ${response.status}`);
    const answer = (data.transcript || '').trim();
    if (!answer) throw new Error('No speech was detected. Try recording your answer again.');
    transcriptText += `${answer} `;
    turnHistory.push({ role: 'user', content: answer });
    conversationTranscript += `Candidate: ${answer}\n`;
    transcript.textContent = conversationTranscript;
    voiceStatus.textContent = 'Preparing a follow-up';
    voiceHint.textContent = 'Sarvam is considering the answer and role criteria.';
    await agentTurn();
    if (listening) {
      voiceStatus.textContent = 'Your turn to answer';
      voiceHint.textContent = 'Tap “Record answer”, speak, then tap it again to send.';
    }
  } catch (error) {
    voiceStatus.textContent = 'Could not process that answer';
    voiceHint.textContent = error.message;
    showToast(error.message);
  } finally {
    recordAnswer.disabled = !listening;
    recordAnswer.textContent = 'Record answer';
  }
}

function startRecording() {
  if (!micStream || !listening) return;
  const mime = audioMimeType();
  audioChunks = [];
  recorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
  recorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
  recorder.onstop = () => {
    clearTimeout(recordingTimer);
    const actualMime = recorder.mimeType || mime || 'audio/webm';
    const blob = new Blob(audioChunks, { type: actualMime });
    processRecording(blob, actualMime);
    recorder = null;
  };
  recorder.start();
  recordAnswer.textContent = 'Stop recording';
  voiceStatus.textContent = 'Recording your answer';
  voiceHint.textContent = 'Speak for up to 25 seconds, then stop the recording.';
  recordingTimer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 25000);
}

recordAnswer.addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    recorder.stop();
    recordAnswer.textContent = 'Processing…';
    return;
  }
  startRecording();
});

function stopVoice() {
  listening = false;
  clearTimeout(recordingTimer);
  if (recorder?.state === 'recording') recorder.stop();
  if (micStream) { micStream.getTracks().forEach(track => track.stop()); micStream = null; }
  if (speechPlayer) { speechPlayer.pause(); speechPlayer = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  voiceModal.classList.remove('listening');
  voiceStatus.textContent = 'Interview ended';
  voiceHint.textContent = 'Preparing recruiter scorecard from the interview evidence.';
  startVoice.disabled = false;
  recordAnswer.disabled = true;
  recordAnswer.textContent = 'Record answer';
  endVoice.disabled = true;
  startVoice.innerHTML = 'Start another interview <span>→</span>';
  if (!transcriptText.trim()) {
    voiceHint.textContent = 'No candidate answers were recorded.';
    return;
  }
  showToast('Generating structured scorecard…');
  fetch('/api/interview/evaluate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate_id: Number(voiceCandidate.value), role: document.getElementById('voiceRole').value, transcript: conversationTranscript })
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not generate the scorecard');
    transcript.innerHTML = `<div class="transcript-history">${escapeHTML(conversationTranscript).replace(/\n/g, '<br>')}</div>${scorecardHTML(data.scorecard)}`;
    const candidate = candidates.find(item => String(item.id) === voiceCandidate.value);
    await loadCandidates();
    runKiwiAction('application_status', { id: Number(voiceCandidate.value), name: candidate?.name || 'Candidate', role: document.getElementById('voiceRole').value }, { scorecard: data.scorecard, proposed_status: 'Recruiter review', action: 'Update application status for recruiter approval.' });
    showToast('Scorecard ready for recruiter review');
    openReview(voiceCandidate.value);
  }).catch(error => showToast(error.message));
}

startVoice.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    voiceStatus.textContent = 'Microphone recording is unavailable';
    voiceHint.textContent = 'Open this app on localhost or HTTPS in a browser that supports MediaRecorder.';
    return;
  }
  const language = document.getElementById('voiceLanguage').value;
  transcriptText = '';
  conversationTranscript = '';
  turnHistory = [];
  transcript.textContent = 'Starting your interview…';
  startVoice.disabled = true;
  voiceModal.classList.add('listening');
  voiceStatus.textContent = 'Requesting microphone access';
  voiceHint.textContent = 'Your microphone recording is sent to Sarvam for transcription.';
  try {
    // Ask for mic permission directly from the button action; no audio is recorded until the candidate taps Record.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    listening = true;
    endVoice.disabled = false;
    const candidate = candidates.find(item => String(item.id) === voiceCandidate.value);
    if (!candidate) throw new Error('Add or select a candidate before starting the interview.');
    await fetch('/api/candidates/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate_id: candidate.id, stage: 'AI interview' }) });
    candidate.stage = 'AI interview';
    renderCandidates();
    voiceStatus.textContent = 'Starting the interview';
    await agentTurn();
    if (listening) {
      recordAnswer.disabled = false;
      voiceStatus.textContent = 'Your turn to answer';
      voiceHint.textContent = 'Tap “Record answer”, speak, then tap it again to send.';
    }
  } catch (error) {
    listening = false;
    if (micStream) { micStream.getTracks().forEach(track => track.stop()); micStream = null; }
    voiceModal.classList.remove('listening');
    voiceStatus.textContent = 'Could not start the interview';
    voiceHint.textContent = error.message;
    startVoice.disabled = false;
    endVoice.disabled = true;
    showToast(error.message);
  }
});
endVoice.addEventListener('click', stopVoice);

async function runKiwiAction(action, candidate, details = {}) {
  try {
    const response = await fetch('/api/kiwi/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, candidate, details })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `KIWI returned ${response.status}`);
    showToast('Sent to KIWI workflow for approval');
  } catch (error) { showToast(error.message); }
}

document.getElementById('newCandidate').addEventListener('click', () => {
  candidateModal.classList.add('open');
  candidateModal.setAttribute('aria-hidden', 'false');
});
const scheduleModal = document.getElementById('scheduleModal');
function closeScheduleModal() {
  scheduleModal.classList.remove('open');
  scheduleModal.setAttribute('aria-hidden', 'true');
}
document.querySelectorAll('.round-add').forEach(button => button.addEventListener('click', () => {
  scheduleModal.classList.add('open');
  scheduleModal.setAttribute('aria-hidden', 'false');
}));
document.getElementById('closeSchedule').addEventListener('click', closeScheduleModal);
document.getElementById('cancelSchedule').addEventListener('click', closeScheduleModal);
scheduleModal.addEventListener('click', event => { if (event.target === scheduleModal) closeScheduleModal(); });
const scheduleDate = document.querySelector('#scheduleForm [name="starts_at"]');
const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
scheduleDate.min = localNow;
document.getElementById('scheduleForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  const candidate = candidates.find(item => String(item.id) === values.candidate_id);
  if (!candidate) return showToast('Add a candidate before scheduling an interview.');
  submit.disabled = true;
  try {
    const body = { ...values, candidate_id: Number(values.candidate_id), duration_minutes: Number(values.duration_minutes), starts_at: new Date(values.starts_at).toISOString() };
    const response = await fetch('/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save interview');
    candidate.stage = 'Scheduled';
    renderCandidates();
    closeScheduleModal();
    await loadInterviews();
    showToast('Interview saved to your calendar');
    runKiwiAction('schedule_interview', { id: candidate.id, name: candidate.name, email: candidate.email, role: candidate.role }, { starts_at: body.starts_at, duration_minutes: body.duration_minutes, language: body.language, action: 'Book this interview in the connected calendar. Keep it pending recruiter approval.' });
  } catch (error) { showToast(error.message); }
  finally { submit.disabled = false; }
});
candidateRows.addEventListener('click', event => {
  const reviewButton = event.target.closest('.row-review');
  if (reviewButton) {
    const row = reviewButton.closest('.candidate-row');
    if (row) openReview(row.dataset.id);
    return;
  }
  const button = event.target.closest('.row-more');
  if (!button) return;
  const row = button.closest('.candidate-row');
  const candidate = candidates.find(item => String(item.id) === row?.dataset.id);
  if (!candidate) return;
  runKiwiAction('draft_outreach', { id: candidate.id, name: candidate.name, email: candidate.email, role: candidate.role }, { action: 'Draft a personalized candidate status update for recruiter review. Do not send it.' });
});
candidateRows.addEventListener('change', async event => {
  const select = event.target.closest('.stage-select');
  if (!select) return;
  const candidate = candidates.find(item => String(item.id) === select.dataset.id);
  if (!candidate) return;
  const previous = candidate.stage;
  candidate.stage = select.value;
  renderCandidates();
  try {
    const response = await fetch('/api/candidates/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate_id: candidate.id, stage: candidate.stage }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update candidate stage');
    runKiwiAction('application_status', { id: candidate.id, name: candidate.name, email: candidate.email, role: candidate.role }, { proposed_status: candidate.stage, action: 'Update candidate stage; keep any candidate message in draft until recruiter approval.' });
  } catch (error) {
    candidate.stage = previous;
    renderCandidates();
    showToast(error.message);
  }
});

function closeCandidateModal() {
  candidateModal.classList.remove('open');
  candidateModal.setAttribute('aria-hidden', 'true');
}
document.getElementById('closeCandidate').addEventListener('click', closeCandidateModal);
document.getElementById('cancelCandidate').addEventListener('click', closeCandidateModal);
candidateModal.addEventListener('click', event => { if (event.target === candidateModal) closeCandidateModal(); });
document.getElementById('candidateForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch('/api/candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save candidate');
    candidates.unshift(data.candidate);
    renderCandidates();
    voiceCandidate.value = String(data.candidate.id);
    document.getElementById('voiceRole').value = data.candidate.role;
    form.reset();
    closeCandidateModal();
    showToast('Candidate saved to your recruiting pipeline');
    runKiwiAction('candidate_intake', data.candidate, { action: 'Add candidate to the recruiting workflow; keep any outreach in draft until recruiter approval.' });
  } catch (error) { showToast(error.message); }
  finally { submit.disabled = false; }
});
voiceCandidate.addEventListener('change', () => {
  const candidate = candidates.find(item => String(item.id) === voiceCandidate.value);
  if (candidate && [...document.getElementById('voiceRole').options].some(option => option.value === candidate.role)) document.getElementById('voiceRole').value = candidate.role;
});
document.getElementById('closeReview').addEventListener('click', closeReview);
document.getElementById('cancelReview').addEventListener('click', closeReview);
document.getElementById('reviewModal').addEventListener('click', event => { if (event.target.id === 'reviewModal') closeReview(); });
document.getElementById('reviewForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!reviewCandidate) return;
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  const decision = document.getElementById('humanDecision').value;
  const feedback = document.getElementById('reviewerFeedback').value;
  try {
    const response = await fetch('/api/candidates/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_id: reviewCandidate.id, human_decision: decision, reviewer_feedback: feedback })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save recruiter review');
    const reviewed = { id: reviewCandidate.id, name: reviewCandidate.name, email: reviewCandidate.email, role: reviewCandidate.role };
    closeReview();
    await loadCandidates();
    showToast('Recruiter review saved');
    if (decision !== 'Pending recruiter decision') {
      runKiwiAction('application_status', reviewed, { proposed_status: decision, recruiter_feedback: feedback, action: 'Prepare this recruiter-selected status update. Do not contact the candidate until the recruiter approves it.' });
    }
  } catch (error) { showToast(error.message); }
  finally { submit.disabled = false; }
});
document.querySelectorAll('.nav-item, .text-link, .calendar-link').forEach(link => {
  if (link.getAttribute('href') === '#') link.addEventListener('click', event => {
    event.preventDefault();
    showToast('This workspace view is ready to connect to your recruiting data.');
  });
});

document.querySelector('.top-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
loadCandidates();
loadInterviews();
