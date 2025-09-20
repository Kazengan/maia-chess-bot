// ==UserScript==
// @name         Chess.com FEN Logger + Floating Controls (turn+EP+castling, auto start/stop/reset)
// @namespace    z-fen-logger
// @version      1.2.0
// @description  Auto-detect live games on chess.com, log FEN, get Maia recommendations, with floating widget.
// @match        https://www.chess.com/game/*
// @match        https://www.chess.com/play/online/*
// @match        https://www.chess.com/live/*
// @connect      maia.cryptils.com
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*************************
   * small utils
   *************************/
  const $  = (sel, r = document) => r.querySelector(sel);
  const $$ = (sel, r = document) => Array.from(r.querySelectorAll(sel));
  const has = (el, cls) => el?.classList?.contains(cls);
  const FILES = ['a','b','c','d','e','f','g','h'];
  const sqName = (fIdx, rIdx) => `${FILES[fIdx]}${rIdx+1}`;
  const nameToIdx = (name) => ({ f: FILES.indexOf(name[0]), r: parseInt(name[1],10)-1 });
  const log = (...args) => console.log('%c[TMP-FEN]', 'color:#09f', ...args);
  const STORE = {
    get paused(){ return localStorage.getItem('zFenLoggerPaused') === '1'; },
    set paused(v){ localStorage.setItem('zFenLoggerPaused', v ? '1' : '0'); }
  };

  /*************************
   * live game detection
   *************************/
  function isLiveGamePresent(root = document) {
    const boardMain = $('#board-layout-main', root);
    const board = $('wc-chess-board#board-single', root);
    const top = $('#board-layout-player-top', root);
    const bot = $('#board-layout-player-bottom', root);
    const clocks = $$('.clock-component', root).length >= 1;
    return !!(boardMain && board && top && bot && clocks);
  }
  function getGameIdFromURL() {
    const m = location.pathname.match(/\/game\/(\d+)|live\/(\d+)|online\/game\/(\d+)/i);
    return m ? (m[1] || m[2] || m[3]) : location.href;
  }

  /*************************
   * global state
   *************************/
  const S = {
    activeListener: null,
    rights: { K:false, Q:false, k:false, q:false },
    epTarget: '-',
    prevBoard: null,
    initialized: false,
    lastHalfmove: 0,
    lastMoveWasPawnOrCapture: false,
    currentGameId: null
  };

  /*************************
   * readers & helpers
   *************************/
  function colorOfContainer(container) {
    if (!container) return null;
    const clock = $('.clock-component', container);
    if (has(clock, 'clock-white')) return 'w';
    if (has(clock, 'clock-black')) return 'b';
    const cap = $('wc-captured-pieces[player-color]', container);
    if (cap) {
      const v = cap.getAttribute('player-color');
      if (v === '1') return 'w';
      if (v === '2') return 'b';
    }
    return null;
  }

  function parsePieces(root = document) {
    const map = {};
    $$('#board-single .piece', root).forEach(el => {
      const cls = el.className || '';
      const mSq = cls.match(/\bsquare-(\d)(\d)\b/);
      const mPc = cls.match(/\b([wb])([kqrbnp])\b/);
      if (!mSq || !mPc) return;
      const f = parseInt(mSq[1], 10) - 1;
      const r = parseInt(mSq[2], 10) - 1;
      const name = sqName(f, r);
      const color = mPc[1] === 'w' ? 'w' : 'b';
      const type = mPc[2].toUpperCase(); // KQRBNP
      map[name] = color + type;
    });
    return map;
  }

  function placementFENFromBoardMap(boardMap) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    Object.entries(boardMap).forEach(([sq, pc]) => {
      const { f, r } = nameToIdx(sq);
      grid[r][f] = (pc[0] === 'w') ? pc[1] : pc[1].toLowerCase();
    });
    const ranks = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', emp = 0;
      for (let f = 0; f < 8; f++) {
        const c = grid[r][f];
        if (c) { if (emp) { row += emp; emp = 0; } row += c; }
        else emp++;
      }
      if (emp) row += emp;
      ranks.push(row);
    }
    return ranks.join('/');
  }

  function parseGameOver(modal, topColor, botColor) {
    let gameOver = false, winner = null, result = null, reason = null;
    if (!modal) return { gameOver, winner, result, reason };
    gameOver = true;

    const titleEl = $('.header-title-component', modal);
    const subtitleEl = $('.header-subtitle-component', modal);
    const title = titleEl?.textContent?.trim() || '';
    const sub = subtitleEl?.innerText?.trim() || '';
    const mReason = sub.match(/by\s+([a-z- ]+)/i);
    if (mReason) reason = mReason[1].trim().toLowerCase();

    if (/white\s+won/i.test(title)) { winner = 'w'; result = '1-0'; }
    else if (/black\s+won/i.test(title)) { winner = 'b'; result = '0-1'; }
    else if (/draw|drawn/i.test(title))  { winner = null; result = '1/2-1/2'; }
    else if (/you\s+won!?/i.test(title)) { winner = colorOfContainer($('#board-layout-player-bottom')) || 'w'; result = winner==='w'?'1-0':'0-1'; }
    else if (/you\s+lost!?/i.test(title)) { winner = colorOfContainer($('#board-layout-player-top')) || 'b'; result = winner==='w'?'1-0':'0-1'; }

    return { gameOver, winner, result, reason };
  }

  function detectChessTurn(root = document) {
    const topC = $('#board-layout-player-top', root);
    const botC = $('#board-layout-player-bottom', root);
    const topColor = colorOfContainer(topC);
    const botColor = colorOfContainer(botC);

    const modal = $('.game-over-modal-content, .game-over-header-component, .game-over-header-header', root);
    let { gameOver, winner, result, reason } = parseGameOver(modal, topColor, botColor);

    if (!gameOver) {
      const eff = $('.animated-effect.winner, .animated-effect.checkmatewhite, .animated-effect.checkmateblack', root);
      if (eff) gameOver = true;
    }

    let active = null;
    if (!gameOver) {
      const turnClock =
        $('#board-layout-player-top .clock-component.clock-player-turn', root) ||
        $('#board-layout-player-bottom .clock-component.clock-player-turn', root) ||
        $('.clock-component.clock-player-turn', root);
      if (turnClock) {
        if (has(turnClock, 'clock-white')) active = 'w';
        else if (has(turnClock, 'clock-black')) active = 'b';
        else {
          const owner = turnClock.closest('#board-layout-player-top, #board-layout-player-bottom');
          if (owner === topC) active = topColor;
          if (owner === botC) active = botColor;
        }
      }
    }

    const label = active === 'w' ? 'white' : active === 'b' ? 'black' : 'unknown';
    const where = (c) => (c === topColor ? 'top' : c === botColor ? 'bottom' : '?');

    return {
      active, label, topColor, botColor,
      activeSidePosition: where(active),
      gameOver, result, winner, reason
    };
  }

  function getHighlightedFromTo(root = document) {
    const hs = $$('#board-single .highlight[class*="square-"]', root);
    const squares = hs.map(el => {
      const m = el.className.match(/\bsquare-(\d)(\d)\b/);
      if (!m) return null;
      const f = parseInt(m[1], 10) - 1;
      const r = parseInt(m[2], 10) - 1;
      return sqName(f, r);
    }).filter(Boolean);
    if (squares.length === 2) return { from: squares[0], to: squares[1] };
    if (squares.length === 1) return { from: squares[0], to: null };
    return { from: null, to: null };
  }

  function updateRightsOnMove(before, after, moverColor, fromSq, toSq) {
    const clrW = (side) => { if (side === 'K') S.rights.K = false; if (side === 'Q') S.rights.Q = false; };
    const clrB = (side) => { if (side === 'k') S.rights.k = false; if (side === 'q') S.rights.q = false; };

    if (moverColor === 'w' && (fromSq === 'e1' || toSq === 'e1' || before['e1'] === 'wK' && after['e1'] !== 'wK')) { S.rights.K = S.rights.Q = false; }
    if (moverColor === 'b' && (fromSq === 'e8' || toSq === 'e8' || before['e8'] === 'bK' && after['e8'] !== 'bK')) { S.rights.k = S.rights.q = false; }

    const movedFrom = (sq, code) => before[sq] === code && after[sq] !== code;
    if (moverColor === 'w') {
      if (movedFrom('h1', 'wR')) clrW('K');
      if (movedFrom('a1', 'wR')) clrW('Q');
    } else {
      if (movedFrom('h8', 'bR')) clrB('k');
      if (movedFrom('a8', 'bR')) clrB('q');
    }
    const capturedFrom = (sq, code) => before[sq] === code && !after[sq];
    if (moverColor === 'w') {
      if (capturedFrom('a8', 'bR')) clrB('q');
      if (capturedFrom('h8', 'bR')) clrB('k');
    } else {
      if (capturedFrom('a1', 'wR')) clrW('Q');
      if (capturedFrom('h1', 'wR')) clrW('K');
    }
    if (moverColor === 'w' && fromSq === 'e1' && (toSq === 'g1' || toSq === 'c1')) { S.rights.K = S.rights.Q = false; }
    if (moverColor === 'b' && fromSq === 'e8' && (toSq === 'g8' || toSq === 'c8')) { S.rights.k = S.rights.q = false; }
  }

  function computeEnPassant(before, after, moverColor, fromSq, toSq) {
    let ep = '-';
    if (!fromSq || !toSq) return ep;
    const from = nameToIdx(fromSq);
    const to = nameToIdx(toSq);
    const movedPiece = after[toSq];
    if (!movedPiece) return ep;
    const isPawn = movedPiece[1] === 'P';
    const sameFile = from.f === to.f;
    const rankDelta = to.r - from.r;
    if (moverColor === 'w' && isPawn && sameFile && rankDelta === +2) ep = sqName(to.f, to.r - 1);
    else if (moverColor === 'b' && isPawn && sameFile && rankDelta === -2) ep = sqName(to.f, to.r + 1);
    return ep;
  }

  function inferCounters(active = 'w') {
    const el = $('wc-vertical-move-list, .vertical-move-list-component, #move-list, .move-list, [data-test-element="movelist"]');
    const txt = (el?.innerText || '').replace(/\s+/g, ' ');
    let lastNum = 1;
    const nums = [...txt.matchAll(/(\d+)\./g)];
    if (nums.length) lastNum = parseInt(nums[nums.length - 1][1], 10);
    const fullmove = (active === 'w') ? (lastNum + 1) : lastNum;
    const halfmove = S.lastMoveWasPawnOrCapture ? 0 : (S.lastHalfmove + 1);
    S.lastHalfmove = halfmove;
    S.lastMoveWasPawnOrCapture = false;
    return { halfmove, fullmove };
  }

  function resetStateFromPosition(mode = 'conservative') {
    const board = parsePieces();
    if (mode === 'off') {
      S.rights = { K:false, Q:false, k:false, q:false };
    } else {
      const wk = board['e1'] === 'wK', wrA = board['a1'] === 'wR', wrH = board['h1'] === 'wR';
      const bk = board['e8'] === 'bK', brA = board['a8'] === 'bR', brH = board['h8'] === 'bR';
      S.rights = { K: wk && wrH, Q: wk && wrA, k: bk && brH, q: bk && brA };
    }
    S.epTarget = '-';
    S.prevBoard = board;
    S.initialized = true;
    S.lastHalfmove = 0;
    S.lastMoveWasPawnOrCapture = false;
  }

  function buildFEN() {
    const info = detectChessTurn();
    const board = parsePieces();
    if (!S.initialized) resetStateFromPosition('conservative');

    const placement = placementFENFromBoardMap(board);
    const castling = (() => {
      let s = '';
      if (S.rights.K) s += 'K';
      if (S.rights.Q) s += 'Q';
      if (S.rights.k) s += 'k';
      if (S.rights.q) s += 'q';
      return s || '-';
    })();
    const active = info.active || 'w';
    const { halfmove, fullmove } = inferCounters(active);
    return `${placement} ${active} ${castling} ${S.epTarget || '-'} ${halfmove} ${fullmove}`;
  }

  function updateStateOnTurnChange() {
    const info = detectChessTurn();
    const boardNow = parsePieces();
    const mover = info.active === 'w' ? 'b' : 'w';

    let { from, to } = getHighlightedFromTo();
    if (!from || !to) {
      const before = S.prevBoard || {};
      const gone = Object.keys(before).filter(sq => before[sq] && !boardNow[sq]);
      const appeared = Object.keys(boardNow).filter(sq => !before[sq] || before[sq] !== boardNow[sq]);
      if (gone.length === 1) from = gone[0];
      if (appeared.length === 1) to = appeared[0];
    }

    updateRightsOnMove(S.prevBoard || {}, boardNow, mover, from, to);
    S.epTarget = computeEnPassant(S.prevBoard || {}, boardNow, mover, from, to);

    let wasPawnOrCapture = false;
    if (from && to) {
      const pieceTo = boardNow[to];
      const captureOccurred = !!(S.prevBoard && S.prevBoard[to] && (S.prevBoard[to][0] !== mover));
      const isPawnMove = pieceTo?.[1] === 'P';
      wasPawnOrCapture = isPawnMove || captureOccurred;
    }
    S.lastMoveWasPawnOrCapture = wasPawnOrCapture;
    S.prevBoard = boardNow;
  }

  function onTurnChange(cb, opts = {}) {
    const throttleMs = Number.isFinite(opts.throttleMs) ? opts.throttleMs : 60;
    let last = null, tId = null;

    const fire = (hint = 'turn') => {
      const info = detectChessTurn();
      const changedTurn = !last || info.active !== last.active;
      const changedGameOver = !last || info.gameOver !== last.gameOver;
      if (hint === 'turn' && changedTurn) cb(info, 'turn');
      if (hint === 'gameover' && changedGameOver) cb(info, 'gameover');
      last = info;
    };
    const schedule = (hint) => {
      if (tId) return;
      tId = setTimeout(() => { tId = null; fire(hint); }, throttleMs);
    };

    const target =
      $('#board-layout-main') ||
      $('#board-layout-chessboard') ||
      $('wc-chess-board') ||
      document;

    const observer = new MutationObserver((muts) => {
      let hint = 'turn';
      muts.forEach(m => {
        if (m.type === 'attributes' && m.target instanceof HTMLElement) {
          if (m.target.matches('.clock-component')) hint = 'turn';
          if (m.target.matches('.game-over-modal-content, .game-over-header-component, .game-over-header-header, .animated-effect.winner, .animated-effect.checkmatewhite, .animated-effect.checkmateblack')) {
            hint = 'gameover';
          }
        } else if (m.type === 'childList') {
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (nodes.some(n => n instanceof HTMLElement && (n.matches?.('.clock-component, .game-over-modal-content, .game-over-header-component, .game-over-header-header') || n.querySelector?.('.clock-component, .game-over-modal-content, .game-over-header-component, .game-over-header-header')))) {
            hint = 'turn';
          }
        }
      });
      updateStateOnTurnChange();
      schedule(hint);
    });

    observer.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['class','style'] });

    updateStateOnTurnChange();
    fire('turn');

    return { disconnect: () => observer.disconnect() };
  }

  /*************************
   * Maia integration
   *************************/
  function getMyElo() {
    const storedElo = localStorage.getItem('zMaiaElo');
    if (storedElo) {
      const elo = parseInt(storedElo, 10);
      if (!isNaN(elo) && elo > 0) return elo;
    }
    return 1100; // Default ELO
  }

  function displayRecommendation(move) {
    const recEl = $('#zMaiaRec', ui);
    if (recEl) recEl.textContent = move;
  }

  function clearRecommendation() {
    const recEl = $('#zMaiaRec', ui);
    if (recEl) recEl.textContent = '';
  }

  async function fetchMaiaMove(fen, elo) {
    const url = `https://maia.cryptils.com/maia?fen=${encodeURIComponent(fen)}&elo=${elo}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      if (data.move) {
        log('Maia recommends:', data.move);
        displayRecommendation(data.move);
      } else {
        log('Maia API returned an error:', data.error || 'Unknown error');
        clearRecommendation();
      }
    } catch (error) {
      log('Failed to fetch recommendation from Maia:', error);
      clearRecommendation();
    }
  }

  /*************************
   * session start/stop/reset + SPA watch
   *************************/
  function startSession() {
    if (S.activeListener) return;
    if (STORE.paused) { log('Paused (OFF). Not starting.'); return; }
    resetStateFromPosition('conservative');
    log('Game detected → start listener');

    S.activeListener = onTurnChange((info, change) => {
      const fen = buildFEN();
      if (change === 'gameover' && info.gameOver) {
        log(`[GAME OVER] winner=${info.winner ?? 'draw'} reason=${info.reason ?? '-'} FEN=${fen}`);
        clearRecommendation();
        stopSession();
        waitForNextGame();
      } else if (change === 'turn') {
        log(`[TURN] ${info.label} (${info.active}) panel=${info.activeSidePosition} FEN=${fen}`);
        const userColor = info.botColor;
        if (info.active && info.active === userColor) {
          log("It's your turn! Getting recommendation...");
          const elo = getMyElo();
          fetchMaiaMove(fen, elo);
        } else {
          clearRecommendation();
        }
      }
    }, { throttleMs: 60 });
    uiSetStatus(true);
  }

  function stopSession() {
    if (S.activeListener) {
      S.activeListener.disconnect();
      S.activeListener = null;
    }
    clearRecommendation();
    uiSetStatus(false);
  }

  let bootObserver = null;
  function waitForNextGame() {
    if (bootObserver) bootObserver.disconnect();
    bootObserver = new MutationObserver(() => {
      const idNow = getGameIdFromURL();
      const hasBoard = isLiveGamePresent();
      if (hasBoard && (!S.currentGameId || idNow !== S.currentGameId || !S.activeListener)) {
        S.currentGameId = idNow;
        startSession();
      }
    });
    bootObserver.observe(document.documentElement, { subtree: true, childList: true });
  }

  const _pushState = history.pushState;
  history.pushState = function () { _pushState.apply(this, arguments); setTimeout(() => {
    S.currentGameId = getGameIdFromURL();
    if (!STORE.paused) waitForNextGame();
  }, 50); };
  window.addEventListener('popstate', () => setTimeout(() => {
    S.currentGameId = getGameIdFromURL();
    if (!STORE.paused) waitForNextGame();
  }, 50));

  function boot() {
    S.currentGameId = getGameIdFromURL();
    if (isLiveGamePresent() && !STORE.paused) startSession();
    else waitForNextGame();
    buildUI(); // floating widget
  }

  /*************************
   * Floating widget (ON/OFF/RESET)
   *************************/
  let ui;
  function buildUI() {
    if (ui) return;
    ui = document.createElement('div');
    ui.id = 'zFenWidget';
    ui.innerHTML = `
      <style>
        #zFenWidget {
          position: fixed; right: 16px; bottom: 16px; z-index: 999999;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        }
        #zFenWidget .panel {
          background: rgba(20,22,28,0.9); color: #e8f0fe;
          border-radius: 10px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
          display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
          border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(4px);
        }
        #zFenWidget .btn {
          appearance: none; border: 1px solid rgba(255,255,255,0.15);
          background: #2b2f3a; color: #e8f0fe; padding: 6px 10px; border-radius: 8px;
          cursor: pointer; font-size: 12px; font-weight: 600;
        }
        #zFenWidget .btn:hover { filter: brightness(1.1); }
        #zFenWidget .btn:active { transform: translateY(1px); }
        #zFenWidget .on { background:#1b5e20; border-color:#2e7d32; }
        #zFenWidget .off{ background:#5d1721; border-color:#7f2230; }
        #zFenWidget .reset{ background:#263238; }
        #zFenWidget .dot { width:10px; height:10px; border-radius:50%; background:#f44336; display:inline-block; margin-right:6px; box-shadow:0 0 0 2px rgba(0,0,0,0.2) inset; }
        #zFenWidget .label{ font-size:12px; opacity:.9; user-select:none; }
        #zFenWidget .drag { cursor: move; opacity:.7; margin-right:6px; }
        #zFenWidget .rec { font-size: 16px; font-weight: bold; color: #ffeb3b; margin-left: 8px; min-width: 60px; text-align: center; font-family: monospace; }
        #zFenWidget .elo-setter { display: flex; gap: 4px; margin-left: 8px; align-items: center; }
        #zFenWidget .elo-input {
            width: 60px; background: #1e222a; border: 1px solid #3c424f;
            color: #e8f0fe; border-radius: 6px; padding: 4px 8px;
            font-size: 12px; text-align: center;
        }
        #zFenWidget .elo-input::-webkit-outer-spin-button,
        #zFenWidget .elo-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        #zFenWidget .elo-input[type=number] { -moz-appearance: textfield; }
        @media (max-width: 640px) { #zFenWidget { right: 8px; bottom: 8px; } }
      </style>
      <div class="panel">
        <span class="drag">↕</span>
        <span class="dot" id="zFenDot"></span>
        <span class="label" id="zFenLabel">OFF</span>
        <button class="btn on"    id="zFenBtnOn">ON</button>
        <button class="btn off"   id="zFenBtnOff">OFF</button>
        <button class="btn reset" id="zFenBtnReset">RESET</button>
        <div id="zMaiaRec" class="rec"></div>
        <div class="elo-setter">
            <input type="number" id="zEloInput" class="elo-input" placeholder="ELO">
            <button id="zEloSetBtn" class="btn">Set</button>
        </div>
      </div>
    `;
    document.body.appendChild(ui);

    // actions
    $('#zFenBtnOn', ui).addEventListener('click', () => { STORE.paused = false; if (!S.activeListener) startSession(); else uiSetStatus(true); });
    $('#zFenBtnOff', ui).addEventListener('click', () => { STORE.paused = true; stopSession(); });
    $('#zFenBtnReset', ui).addEventListener('click', () => { resetStateFromPosition('conservative'); log('[RESET] rights=', S.rights, 'ep=', S.epTarget); });

    // ELO setter
    const eloInput = $('#zEloInput', ui);
    eloInput.value = getMyElo();
    $('#zEloSetBtn', ui).addEventListener('click', () => {
        const newElo = parseInt(eloInput.value, 10);
        if (!isNaN(newElo) && newElo > 0) {
            localStorage.setItem('zMaiaElo', newElo);
            log(`ELO set to ${newElo}`);
            eloInput.style.borderColor = '#4caf50';
            setTimeout(() => { eloInput.style.borderColor = ''; }, 1500);
        } else {
            log(`Invalid ELO value: ${eloInput.value}`);
            eloInput.style.borderColor = '#f44336';
            setTimeout(() => { eloInput.style.borderColor = ''; }, 1500);
        }
    });

    // draggable (simple)
    makeDraggable(ui.querySelector('.panel'), ui);

    // initial label
    uiSetStatus(!!S.activeListener && !STORE.paused);
  }

  function uiSetStatus(isOn) {
    const dot = $('#zFenDot', ui);
    const label = $('#zFenLabel', ui);
    if (!dot || !label) return;
    if (isOn && !STORE.paused) {
      dot.style.background = '#4caf50';
      label.textContent = 'ON';
    } else {
      dot.style.background = '#f44336';
      label.textContent = 'OFF';
    }
  }

  function makeDraggable(handleEl, rootEl) {
    let sx=0, sy=0, ox=0, oy=0, dragging=false;
    const onDown = (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const rect = rootEl.getBoundingClientRect();
      ox = rect.right - window.innerWidth; // negative
      oy = rect.bottom - window.innerHeight;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      rootEl.style.right = `${16 - ox - dx}px`;
      rootEl.style.bottom = `${16 - oy - dy}px`;
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    handleEl.addEventListener('mousedown', onDown);
  }

  /*************************
   * boot
   *************************/
  (function bootAll(){
    S.currentGameId = getGameIdFromURL();
    if (isLiveGamePresent() && !STORE.paused) startSession();
    else waitForNextGame();
    buildUI();
    // expose a small debug API
    window.__fenLogger = {
      start: () => { STORE.paused=false; startSession(); },
      stop:  () => { STORE.paused=true;  stopSession();  },
      reset: () => resetStateFromPosition('conservative')
    };
  })();
})();
