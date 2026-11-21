(() => {
  'use strict';

  const stageEl = document.getElementById('overlay-stage');
  const boxEl = document.getElementById('counter-box');
  const labelEl = document.getElementById('counter-label');
  const amountEl = document.getElementById('counter-amount');
  const goalBlockEl = document.getElementById('goal-block');
  const goalTargetTextEl = document.getElementById('goal-target-text');
  const goalStatusTextEl = document.getElementById('goal-status-text');
  const goalBarFillEl = document.getElementById('goal-bar-fill');

  const params = new URLSearchParams(window.location.search);

  // URLクエリ ?goal=off が明示指定されている場合はオーバーレイ側で強制非表示にできる
  const forceHideGoal = (params.get('goal') || '').toLowerCase() === 'off';

  // カウントアップアニメーションの継続時間（ミリ秒）
  const animDuration = clampNumber(Number(params.get('duration')), 100, 3000, 650);

  let displayedValue = 0;
  let targetValue = 0;
  let currentGoal = { targetJpy: 0, visible: false, achieved: false };
  let animFrameId = null;
  let reconnectTimer = null;

  /**
   * 数値の範囲制限ヘルパー
   */
  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value) || value === 0) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  /**
   * URLクエリパラメータから見た目をカスタマイズする
   * 例: /overlay?color=white&align=right&valign=bottom&size=48&bg=badge&label=課金合計&stroke=on
   */
  function applyQueryStyles() {
    // 文字色（?color=...）
    const color = params.get('color');
    if (color && /^[#a-zA-Z0-9(),.\s%-]{1,40}$/.test(color)) {
      boxEl.style.setProperty('--overlay-color', color);
    }

    // 横配置（?align=left|center|right）
    const align = (params.get('align') || 'left').toLowerCase();
    stageEl.classList.remove('align-left', 'align-center', 'align-right');
    if (align === 'center' || align === 'right') {
      stageEl.classList.add(`align-${align}`);
    } else {
      stageEl.classList.add('align-left');
    }

    // 縦配置（?valign=top|middle|bottom）
    const valign = (params.get('valign') || 'top').toLowerCase();
    stageEl.classList.remove('valign-top', 'valign-middle', 'valign-bottom');
    if (valign === 'middle' || valign === 'bottom') {
      stageEl.classList.add(`valign-${valign}`);
    } else {
      stageEl.classList.add('valign-top');
    }

    // フォントサイズ（?size=56）
    const rawSize = Number(params.get('size'));
    if (Number.isFinite(rawSize) && rawSize >= 18 && rawSize <= 180) {
      boxEl.style.setProperty('--overlay-size', `${rawSize}px`);
    }

    // 目標額の文字サイズ個別指定（?goalSize=32）
    const rawGoalSize = Number(params.get('goalSize'));
    if (Number.isFinite(rawGoalSize) && rawGoalSize >= 14 && rawGoalSize <= 120) {
      boxEl.style.setProperty('--overlay-goal-size', `${rawGoalSize}px`);
    }

    // 背景スタイル（?bg=badge|dark|light|none）
    const bg = (params.get('bg') || 'badge').toLowerCase();
    boxEl.classList.remove('bg-badge', 'bg-dark', 'bg-light', 'bg-none');
    if (bg === 'dark' || bg === 'light' || bg === 'none') {
      boxEl.classList.add(`bg-${bg}`);
      // bg=light で色未指定のときはゆめかわパープル文字にする
      if (bg === 'light' && !color) {
        boxEl.style.setProperty('--overlay-color', '#4c2a6a');
      }
    } else {
      boxEl.classList.add('bg-badge');
    }

    // 縁取り（?stroke=on|strong|off）
    const stroke = (params.get('stroke') || (bg === 'none' ? 'strong' : 'on')).toLowerCase();
    boxEl.classList.remove('stroke-on', 'stroke-strong', 'stroke-off');
    if (stroke === 'strong' || stroke === 'off') {
      boxEl.classList.add(`stroke-${stroke}`);
    } else {
      boxEl.classList.add('stroke-on');
    }

    // ラベル文言（?label=...、none または空文字で非表示）
    if (params.has('label')) {
      const labelText = params.get('label').trim();
      if (!labelText || labelText.toLowerCase() === 'none') {
        labelEl.classList.add('hidden');
      } else {
        labelEl.textContent = labelText;
        labelEl.classList.remove('hidden');
      }
    }
  }

  /**
   * 金額を日本円フォーマットで描画
   */
  function renderValue(value) {
    amountEl.textContent = `¥${Math.round(value).toLocaleString('ja-JP')}`;
  }

  /**
   * 目標額・進捗バーの描画を更新（達成中はオーバーレイ上で紙吹雪を継続表示）
   */
  function renderGoal(goal, totalJpy) {
    if (goal) {
      currentGoal = goal;
    }

    const goalTarget = Math.max(0, Number(currentGoal?.targetJpy) || 0);
    const shouldShow = !forceHideGoal && Boolean(currentGoal?.visible) && goalTarget > 0;

    if (!shouldShow) {
      goalBlockEl.classList.add('hidden');
      if (typeof window.setContinuousConfetti === 'function') {
        window.setContinuousConfetti(false);
      }
      return;
    }

    const safeTotal = Math.max(0, Number(totalJpy) || 0);
    const percent = (safeTotal / goalTarget) * 100;
    const clampedWidth = Math.min(100, percent);
    const isAchieved = safeTotal >= goalTarget;

    goalBlockEl.classList.remove('hidden');
    goalTargetTextEl.textContent = `目標 ¥${Math.round(goalTarget).toLocaleString('ja-JP')}`;
    goalStatusTextEl.textContent = isAchieved ? '達成！🎉' : `${percent.toFixed(0)}%`;
    goalStatusTextEl.classList.toggle('achieved', isAchieved);
    goalBarFillEl.style.width = `${clampedWidth}%`;
    goalBarFillEl.classList.toggle('achieved', isAchieved);

    // 目標額を達成している間はオーバーレイに被せる形で紙吹雪を表示し続ける
    if (typeof window.setContinuousConfetti === 'function') {
      window.setContinuousConfetti(isAchieved);
    }
  }

  /**
   * 紙吹雪とお祝いハイライトを発火
   */
  function triggerCelebration() {
    if (typeof window.launchConfetti === 'function') {
      window.launchConfetti();
    }
    boxEl.classList.remove('celebrate-glow');
    void boxEl.offsetWidth;
    boxEl.classList.add('celebrate-glow');
  }

  /**
   * 目標金額まで滑らかにカウントアップ（リセット時は即時反映）
   */
  function animateTo(nextTotal, options = { immediate: false, pulse: false }) {
    const safeNext = Math.max(0, Math.round(Number(nextTotal) || 0));

    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    if (options.pulse && safeNext > targetValue) {
      boxEl.classList.remove('pulse');
      // リフローを発生させて連続加算時もアニメーションを再実行
      void boxEl.offsetWidth;
      boxEl.classList.add('pulse');
    }

    targetValue = safeNext;

    if (options.immediate || displayedValue === targetValue) {
      displayedValue = targetValue;
      renderValue(displayedValue);
      return;
    }

    const startValue = displayedValue;
    const diff = targetValue - startValue;
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / animDuration);
      // easeOutCubic で自然な減速カウントアップ
      const eased = 1 - Math.pow(1 - progress, 3);
      displayedValue = startValue + diff * eased;
      renderValue(displayedValue);

      if (progress < 1) {
        animFrameId = requestAnimationFrame(step);
      } else {
        displayedValue = targetValue;
        renderValue(displayedValue);
        animFrameId = null;
      }
    }

    animFrameId = requestAnimationFrame(step);
  }

  /**
   * WebSocket 接続（OBS起動中でもサーバー再起動に自動追従）
   */
  function connectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') {
          const total = message.payload?.totalJpy ?? 0;
          animateTo(total, { immediate: true, pulse: false });
          renderGoal(message.payload?.goal, total);
        } else if (message.type === 'donation') {
          const snap = message.payload?.snapshot;
          const total = snap?.totalJpy ?? 0;
          animateTo(total, { immediate: false, pulse: true });
          renderGoal(snap?.goal, total);
        } else if (message.type === 'reset') {
          const total = message.payload?.totalJpy ?? 0;
          animateTo(total, { immediate: true, pulse: false });
          renderGoal(message.payload?.goal, total);
        } else if (message.type === 'celebrate') {
          triggerCelebration();
        }
      } catch (err) {
        console.error('オーバーレイ用WSメッセージ解析エラー:', err);
      }
    });

    ws.addEventListener('close', () => {
      reconnectTimer = setTimeout(connectWebSocket, 2500);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  /**
   * 初期値の取得
   */
  async function fetchInitial() {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data = await res.json();
        const total = data.totalJpy ?? 0;
        animateTo(total, { immediate: true, pulse: false });
        renderGoal(data.goal, total);
      }
    } catch {
      // WS接続時に再同期されるため無視
    }
  }

  applyQueryStyles();
  fetchInitial();
  connectWebSocket();
})();
