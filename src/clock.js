// The page's clock: the audio's position while the audio plays, then the page's own time through the
// end card after the audio (dur .. dur + cardLen: src/card.js), which the audio element cannot play.
// No DOM and no global time source: the caller passes the audio state { time, paused, ended } and the
// time in milliseconds. The time returned goes through clampT before anything is drawn.
export function createClock(dur, cardLen) {
  const end = dur + cardLen;
  let inCard = false; // the clock runs the end card on its own (else it follows the audio)
  let cardPaused = false;
  let base = 0; // the card's time at baseMs
  let baseMs = 0;
  let cur = 0; // the card's time at the last read, toggle or start
  let lastAudio = -1;
  let lastMs = 0;

  const cardTime = (nowMs) => (cardPaused ? cur : Math.min(base + (nowMs - baseMs) / 1000, end));

  function enterCard(t0, nowMs, paused = false) {
    inCard = true;
    cardPaused = paused;
    base = cur = Math.min(t0, end);
    baseMs = nowMs;
  }

  return {
    read(audio, nowMs) {
      if (!inCard && audio.ended) enterCard(Math.max(audio.time, dur), nowMs);
      if (inCard) return (cur = cardTime(nowMs));
      // the audio position, smoothed between its updates; never past dur before the audio has ended
      // (else the end card's cut would show for a frame and go when the ended event comes)
      if (audio.time !== lastAudio || audio.paused) {
        lastAudio = audio.time;
        lastMs = nowMs;
        return audio.time;
      }
      return Math.min(audio.time + Math.min((nowMs - lastMs) / 1000, 0.1), Math.max(audio.time, dur));
    },
    // in the end card: pause or resume and say true; otherwise false (the caller plays or pauses the audio)
    toggle(nowMs) {
      if (!inCard || cur >= end) return false;
      cur = cardTime(nowMs);
      cardPaused = !cardPaused;
      base = cur;
      baseMs = nowMs;
      return true;
    },
    // the end card from t0 (at most its end) without the audio: running, or standing there when paused
    // (a still or a seek after the audio)
    startAt(t0, nowMs, paused = false) {
      enterCard(t0, nowMs, paused);
    },
    reset() {
      inCard = false;
      cardPaused = false;
      lastAudio = -1;
    },
    inCard() {
      return inCard;
    },
    // in the end card and its time running (not paused, not at its end)
    running() {
      return inCard && !cardPaused && cur < end;
    },
    atEnd() {
      return inCard && cur >= end;
    },
  };
}
