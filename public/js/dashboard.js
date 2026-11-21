(() => {
  'use strict';

  const els = {
    wsIndicator: document.getElementById('ws-indicator'),
    wsStatusText: document.getElementById('ws-status-text'),
    testToggleBtn: document.getElementById('test-toggle-btn'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    monitorForm: document.getElementById('monitor-form'),
    streamUrlInput: document.getElementById('stream-url-input'),
    startBtn: document.getElementById('start-btn'),
    stopBtn: document.getElementById('stop-btn'),
    resetBtn: document.getElementById('reset-btn'),
    monitorBadge: document.getElementById('monitor-badge'),
    streamMeta: document.getElementById('stream-meta'),
    streamTitle: document.getElementById('stream-title'),
    streamChannel: document.getElementById('stream-channel'),
    streamVideoId: document.getElementById('stream-video-id'),
    monitorError: document.getElementById('monitor-error'),
    obsUrlCode: document.getElementById('obs-url-code'),
    copyObsUrlBtn: document.getElementById('copy-obs-url-btn'),
    totalJpy: document.getElementById('total-jpy'),
    totalCount: document.getElementById('total-count'),
    excludedCount: document.getElementById('excluded-count'),
    goalForm: document.getElementById('goal-form'),
    goalAmountInput: document.getElementById('goal-amount-input'),
    goalVisibleToggle: document.getElementById('goal-visible-toggle'),
    goalVisibleLabel: document.getElementById('goal-visible-label'),
    goalAchievedBadge: document.getElementById('goal-achieved-badge'),
    goalProgressText: document.getElementById('goal-progress-text'),
    goalProgressPercent: document.getElementById('goal-progress-percent'),
    goalProgressBar: document.getElementById('goal-progress-bar'),
    goalVisibilityNote: document.getElementById('goal-visibility-note'),
    typeBreakdownList: document.getElementById('type-breakdown-list'),
    currencyBreakdownList: document.getElementById('currency-breakdown-list'),
    rateMetaText: document.getElementById('rate-meta-text'),
    refreshRatesBtn: document.getElementById('refresh-rates-btn'),
    testPanel: document.getElementById('test-panel'),
    testConfettiBtn: document.getElementById('test-confetti-btn'),
    historyCountLabel: document.getElementById('history-count-label'),
    historyTbody: document.getElementById('history-tbody'),
    toastContainer: document.getElementById('toast-container'),
  };

  let currentSnapshot = null;
  let testPanelVisible = false; // 普段は非表示（トグル操作で開閉）
  let ws = null;
  let reconnectTimer = null;

  /**
   * 金額を日本円表示（例: ¥12,340）へフォーマット
   */
  function formatJpy(amount) {
    const num = Number(amount) || 0;
    return `¥${Math.round(num).toLocaleString('ja-JP')}`;
  }

  /**
   * 日時を読みやすいローカル表記へフォーマット
   */
  function formatDateTime(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) {
      return isoString || '-';
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * HTMLエスケープ
   */
  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 画面右下にトースト通知を表示
   */
  function showToast(message, variant = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${variant}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 3500);
  }

  /**
   * OBSオーバーレイURLを初期化表示
   */
  function initObsUrl() {
    const obsUrl = `${window.location.origin}/overlay`;
    els.obsUrlCode.textContent = obsUrl;
  }

  /**
   * テーマ（ゆめかわオーロラ / ナイトオーロラ）の初期化と切替
   */
  function initTheme() {
    const saved = localStorage.getItem('yt-sc-theme-v2');
    const initial = saved === 'dark' ? 'dark' : 'aurora';
    applyTheme(initial);

    els.themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'aurora' : 'dark';
      applyTheme(next);
      localStorage.setItem('yt-sc-theme-v2', next);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    els.themeToggleBtn.textContent = theme === 'dark' ? 'オーロラ表示' : 'ナイト表示';
  }

  /**
   * 監視ステータス表示の更新
   */
  function renderMonitorState(monitor) {
    if (!monitor) {
      return;
    }

    const badgeMap = {
      idle: { text: '待機中', cls: 'status-idle' },
      connecting: { text: '接続中...', cls: 'status-connecting' },
      monitoring: { text: '監視中（LIVE）', cls: 'status-monitoring' },
      error: { text: 'エラー', cls: 'status-error' },
    };

    const badge = badgeMap[monitor.status] || badgeMap.idle;
    els.monitorBadge.textContent = badge.text;
    els.monitorBadge.className = `status-badge ${badge.cls}`;

    const isBusy = monitor.status === 'connecting' || monitor.status === 'monitoring';
    els.stopBtn.disabled = !isBusy;
    els.startBtn.disabled = monitor.status === 'connecting';

    if (monitor.videoUrl && !els.streamUrlInput.value) {
      els.streamUrlInput.value = monitor.videoUrl;
    }

    if (monitor.videoId) {
      els.streamMeta.classList.remove('hidden');
      els.streamTitle.textContent = monitor.streamTitle || '取得中...';
      els.streamChannel.textContent = monitor.channelName || '-';
      els.streamVideoId.textContent = monitor.videoId;
    } else {
      els.streamMeta.classList.add('hidden');
    }

    if (monitor.lastError) {
      els.monitorError.textContent = monitor.lastError;
      els.monitorError.classList.remove('hidden');
    } else {
      els.monitorError.classList.add('hidden');
    }
  }

  /**
   * テストパネルの表示状態を同期する（デフォルト非表示）
   */
  function syncTestPanelVisibility(testModeEnabled) {
    if (!testModeEnabled) {
      els.testToggleBtn.classList.add('hidden');
      els.testPanel.classList.add('hidden');
      return;
    }

    els.testToggleBtn.classList.remove('hidden');
    els.testToggleBtn.textContent = testPanelVisible ? 'テスト表示: ON' : 'テスト表示: OFF';
    els.testToggleBtn.setAttribute('aria-expanded', String(testPanelVisible));
    els.testToggleBtn.classList.toggle('btn-toggle-active', testPanelVisible);
    els.testPanel.classList.toggle('hidden', !testPanelVisible);
  }

  /**
   * 目標額・進捗状況の描画
   */
  function renderGoalState(goal, totalJpy) {
    const targetJpy = Math.max(0, Number(goal?.targetJpy) || 0);
    const visible = Boolean(goal?.visible);
    const safeTotal = Math.max(0, Number(totalJpy) || 0);

    // 入力中でなければ入力欄へ反映
    if (document.activeElement !== els.goalAmountInput) {
      els.goalAmountInput.value = targetJpy > 0 ? String(targetJpy) : '';
    }

    els.goalVisibleToggle.checked = visible;
    els.goalVisibleLabel.textContent = visible ? '目標額表示: ON' : '目標額表示: OFF';

    if (targetJpy <= 0) {
      els.goalAchievedBadge.classList.add('hidden');
      els.goalProgressText.textContent = '目標額が未設定です';
      els.goalProgressPercent.textContent = '0%';
      els.goalProgressPercent.classList.remove('achieved');
      els.goalProgressBar.style.width = '0%';
      els.goalProgressBar.classList.remove('achieved');
    } else {
      const rawPercent = (safeTotal / targetJpy) * 100;
      const clampedBar = Math.min(100, rawPercent);
      const isAchieved = safeTotal >= targetJpy;
      const remaining = Math.max(0, targetJpy - safeTotal);

      els.goalAchievedBadge.classList.toggle('hidden', !isAchieved);
      els.goalProgressPercent.textContent = `${rawPercent.toFixed(1)}%`;
      els.goalProgressPercent.classList.toggle('achieved', isAchieved);
      els.goalProgressBar.style.width = `${clampedBar}%`;
      els.goalProgressBar.classList.toggle('achieved', isAchieved);

      if (isAchieved) {
        els.goalProgressText.textContent = `目標 ${formatJpy(targetJpy)} を達成しました！（現在 ${formatJpy(safeTotal)}）`;
      } else {
        els.goalProgressText.textContent = `目標 ${formatJpy(targetJpy)} まで あと ${formatJpy(remaining)}`;
      }
    }

    if (visible && targetJpy > 0) {
      els.goalVisibilityNote.textContent =
        '現在 ON：OBSオーバーレイに目標額・進捗バーを表示中です（達成時に紙吹雪エフェクトが発火します）。';
    } else if (visible && targetJpy === 0) {
      els.goalVisibilityNote.textContent =
        '表示は ON ですが目標金額が未設定です。目標金額を設定するとOBSオーバーレイへ表示されます。';
    } else {
      els.goalVisibilityNote.textContent =
        '現在 OFF：OBSオーバーレイには合計金額のみ表示されます（目標額と進捗バーは非表示）。';
    }
  }

  /**
   * 目標額設定をサーバーへ送信・保存する
   */
  async function saveGoalSettings(patch, toastMessage) {
    try {
      const res = await fetch('/api/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || '目標額設定の更新に失敗しました。', 'error');
        return;
      }
      if (data.snapshot) {
        renderSnapshot(data.snapshot);
      }
      if (toastMessage) {
        showToast(toastMessage, 'success');
      }
    } catch {
      showToast('目標額設定の通信に失敗しました。', 'error');
    }
  }

  /**
   * スナップショット全体の画面描画
   */
  function renderSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }
    currentSnapshot = snapshot;

    // テストパネルの表示制御（普段は非表示、トグル時のみ表示）
    syncTestPanelVisibility(Boolean(snapshot.testModeEnabled));

    // 監視ステータス
    renderMonitorState(snapshot.monitor);

    // 目標額・進捗バー
    renderGoalState(snapshot.goal, snapshot.totalJpy);

    // KPIサマリー
    els.totalJpy.textContent = formatJpy(snapshot.totalJpy);
    els.totalCount.textContent = `${(snapshot.totalCount || 0).toLocaleString('ja-JP')} 件`;
    els.excludedCount.textContent = `${(snapshot.excludedMembershipCount || 0).toLocaleString('ja-JP')} 件`;

    // 種別ごと内訳
    if (Array.isArray(snapshot.byType) && snapshot.byType.length > 0) {
      els.typeBreakdownList.innerHTML = snapshot.byType
        .map(
          (item) => `
          <div class="breakdown-row">
            <div class="breakdown-left">
              <span class="breakdown-title">${escapeHtml(item.label)}</span>
              <span class="breakdown-meta">${item.count.toLocaleString('ja-JP')} 件</span>
            </div>
            <div class="breakdown-right">
              <div class="breakdown-jpy">${formatJpy(item.jpyTotal)}</div>
            </div>
          </div>
        `
        )
        .join('');
    }

    // 為替レート取得元・主要レートの表示
    if (snapshot.exchangeRateMeta && snapshot.exchangeRates) {
      const meta = snapshot.exchangeRateMeta;
      const r = snapshot.exchangeRates;
      const sample = ['USD', 'EUR', 'TWD']
        .filter((code) => typeof r[code] === 'number')
        .map((code) => `${code} ¥${r[code].toFixed(2)}`)
        .join(' / ');
      const fetchedLabel = meta.fetchedAt ? `（${formatDateTime(meta.fetchedAt)} 取得）` : '';
      els.rateMetaText.textContent = `${meta.provider}${fetchedLabel}${sample ? ` | ${sample}` : ''}`;
    }

    // 通貨別内訳
    if (Array.isArray(snapshot.byCurrency) && snapshot.byCurrency.length > 0) {
      els.currencyBreakdownList.innerHTML = snapshot.byCurrency
        .map((item) => {
          const unknownTag = item.isUnknown ? '<span class="unknown-tag">レート未設定</span>' : '';
          const origDisplay =
            item.currency === 'JEWEL'
              ? `${item.originalTotal.toLocaleString('ja-JP')} ジュエル`
              : `${item.originalTotal.toLocaleString('ja-JP')} ${escapeHtml(item.currency)}`;
          return `
            <div class="breakdown-row">
              <div class="breakdown-left">
                <span class="breakdown-title">${escapeHtml(item.currency)}${unknownTag}</span>
                <span class="breakdown-meta">元金額合計: ${origDisplay}（${item.count.toLocaleString('ja-JP')} 件）</span>
              </div>
              <div class="breakdown-right">
                <div class="breakdown-jpy">${formatJpy(item.jpyTotal)}</div>
              </div>
            </div>
          `;
        })
        .join('');
    } else {
      els.currencyBreakdownList.innerHTML = '<div class="empty-state">まだ集計データがありません</div>';
    }

    // 履歴テーブル（最大200件表示、CSVは全件出力）
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const displayEvents = events.slice(0, 200);
    els.historyCountLabel.textContent =
      events.length > 200
        ? `最新 200 件を表示中（全 ${events.length.toLocaleString('ja-JP')} 件・CSVは全件出力）`
        : `${events.length.toLocaleString('ja-JP')} 件表示`;

    if (displayEvents.length === 0) {
      els.historyTbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-cell">課金イベントを受信するとここにリアルタイム表示されます</td>
        </tr>
      `;
    } else {
      els.historyTbody.innerHTML = displayEvents
        .map((ev) => {
          const simBadge = ev.isSimulated ? '<span class="sim-tag">TEST</span>' : '';
          const unknownWarn = ev.isUnknownCurrency ? ' <span class="unknown-tag">未換算</span>' : '';
          return `
            <tr>
              <td>${escapeHtml(formatDateTime(ev.timestamp))}</td>
              <td>${escapeHtml(ev.authorName)}${simBadge}</td>
              <td><span class="type-chip type-${escapeHtml(ev.type)}">${escapeHtml(ev.typeLabel)}</span></td>
              <td>${escapeHtml(ev.rawAmountText)} <span class="hint-text">(${escapeHtml(ev.currency)})</span></td>
              <td class="text-right"><strong>${formatJpy(ev.jpyAmount)}</strong>${unknownWarn}</td>
              <td class="msg-cell">${escapeHtml(ev.message || '-')}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  /**
   * WebSocket 接続・自動再接続
   */
  function connectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      els.wsIndicator.className = 'ws-pill ws-connected';
      els.wsStatusText.textContent = 'リアルタイム接続中';
    });

    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWsMessage(message);
      } catch (err) {
        console.error('WebSocketメッセージの解析に失敗しました:', err);
      }
    });

    ws.addEventListener('close', () => {
      els.wsIndicator.className = 'ws-pill ws-disconnected';
      els.wsStatusText.textContent = '再接続待機中...';
      reconnectTimer = setTimeout(connectWebSocket, 2500);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  /**
   * WebSocket受信メッセージの処理
   */
  function handleWsMessage(message) {
    switch (message.type) {
      case 'state':
      case 'reset':
        renderSnapshot(message.payload);
        break;
      case 'donation':
        renderSnapshot(message.payload.snapshot);
        break;
      case 'status':
        if (currentSnapshot) {
          currentSnapshot.monitor = message.payload;
        }
        renderMonitorState(message.payload);
        break;
      case 'excluded':
        els.excludedCount.textContent = `${(message.payload.excludedMembershipCount || 0).toLocaleString('ja-JP')} 件`;
        break;
      case 'celebrate':
        if (message.payload?.reason === 'goal_achieved') {
          showToast(
            `🎉 目標額 ${formatJpy(message.payload.targetJpy)} を達成しました！（OBSオーバーレイで紙吹雪を表示中）`,
            'success'
          );
        }
        break;
      default:
        break;
    }
  }

  /**
   * 初期データ取得（WS接続前のフォールバック）
   */
  async function fetchInitialState() {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const snapshot = await res.json();
        renderSnapshot(snapshot);
      }
    } catch (err) {
      console.error('初期状態の取得に失敗しました:', err);
    }
  }

  /**
   * UIイベントの登録
   */
  function bindEvents() {
    // 監視開始
    els.monitorForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = els.streamUrlInput.value.trim();
      if (!url) {
        showToast('YouTube配信URLまたは動画IDを入力してください。', 'warning');
        return;
      }

      els.startBtn.disabled = true;
      els.monitorError.classList.add('hidden');

      try {
        const res = await fetch('/api/monitor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || '監視の開始に失敗しました。', 'error');
        } else {
          showToast('YouTube Live チャットの監視を開始しました。', 'success');
        }
        if (data.monitor) {
          renderMonitorState(data.monitor);
        }
      } catch {
        showToast('サーバーへの接続に失敗しました。', 'error');
        els.startBtn.disabled = false;
      }
    });

    // 監視停止
    els.stopBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/monitor/stop', { method: 'POST' });
        const data = await res.json();
        if (data.monitor) {
          renderMonitorState(data.monitor);
        }
        showToast('チャット監視を停止しました。', 'info');
      } catch {
        showToast('監視停止リクエストに失敗しました。', 'error');
      }
    });

    // 集計リセット
    els.resetBtn.addEventListener('click', async () => {
      const confirmed = window.confirm(
        '現在の集計金額と課金履歴をすべてリセットしますか？（保存済みのセッションデータも初期化されます）'
      );
      if (!confirmed) {
        return;
      }

      try {
        const res = await fetch('/api/session/reset', { method: 'POST' });
        const data = await res.json();
        if (data.snapshot) {
          renderSnapshot(data.snapshot);
        }
        showToast('集計データをリセットしました。', 'success');
      } catch {
        showToast('リセットに失敗しました。', 'error');
      }
    });

    // OBSオーバーレイURLのコピー
    els.copyObsUrlBtn.addEventListener('click', async () => {
      const url = els.obsUrlCode.textContent;
      try {
        await navigator.clipboard.writeText(url);
        showToast('OBSオーバーレイURLをクリップボードにコピーしました。', 'success');
      } catch {
        showToast('URLのコピーに失敗しました。手動で選択してコピーしてください。', 'warning');
      }
    });

    // テストパネルの表示トグル（普段は非表示）
    els.testToggleBtn.addEventListener('click', () => {
      testPanelVisible = !testPanelVisible;
      syncTestPanelVisibility(Boolean(currentSnapshot?.testModeEnabled));
    });

    // 目標額の表示 ON/OFF トグル
    els.goalVisibleToggle.addEventListener('change', () => {
      const nextVisible = els.goalVisibleToggle.checked;
      void saveGoalSettings(
        { visible: nextVisible },
        nextVisible ? '目標額の表示を ON にしました（OBSへ反映）。' : '目標額の表示を OFF にしました（OBSへ反映）。'
      );
    });

    // 目標額の設定フォーム送信
    els.goalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = els.goalAmountInput.value.trim();
      const value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        showToast('目標金額は 0 以上の数値で入力してください。', 'warning');
        return;
      }
      const rounded = Math.round(value);
      // 金額を入力して設定した場合は、見やすいよう表示も自動でONにする（0指定時は維持）
      const patch = rounded > 0 ? { targetJpy: rounded, visible: true } : { targetJpy: 0 };
      void saveGoalSettings(
        patch,
        rounded > 0
          ? `目標額を ${formatJpy(rounded)} に設定しました（表示ON）。`
          : '目標額の設定を解除しました。'
      );
    });

    // 目標額プリセットボタン
    document.querySelectorAll('[data-goal-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetVal = Number(btn.getAttribute('data-goal-preset'));
        if (!Number.isFinite(presetVal) || presetVal <= 0) {
          return;
        }
        els.goalAmountInput.value = String(presetVal);
        void saveGoalSettings(
          { targetJpy: presetVal, visible: true },
          `目標額を ${formatJpy(presetVal)} に設定しました（表示ON）。`
        );
      });
    });

    // テストモード：紙吹雪テストボタン
    if (els.testConfettiBtn) {
      els.testConfettiBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/test/confetti', { method: 'POST' });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || '紙吹雪テストの実行に失敗しました。', 'error');
            return;
          }
          showToast(data.detail, 'success');
        } catch {
          showToast('紙吹雪テスト中に通信エラーが発生しました。', 'error');
        }
      });
    }

    // 為替レートの手動再取得
    els.refreshRatesBtn.addEventListener('click', async () => {
      els.refreshRatesBtn.disabled = true;
      els.refreshRatesBtn.textContent = '取得中...';
      try {
        const res = await fetch('/api/rates/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.snapshot) {
          renderSnapshot(data.snapshot);
        }
        if (!res.ok) {
          showToast(data.error || '為替レートの再取得に失敗しました。', 'warning');
        } else {
          showToast(`最新の為替レートを取得しました（${data.meta?.provider || ''}）。`, 'success');
        }
      } catch {
        showToast('為替レート再取得中に通信エラーが発生しました。', 'error');
      } finally {
        els.refreshRatesBtn.disabled = false;
        els.refreshRatesBtn.textContent = 'レート再取得';
      }
    });

    // テストモードのダミーイベント発火ボタン
    document.querySelectorAll('[data-simulate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const preset = btn.getAttribute('data-simulate');
        try {
          const res = await fetch('/api/test/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset }),
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'テストイベント送信に失敗しました。', 'error');
            return;
          }
          const variant = data.resultKind === 'donation' ? 'success' : 'warning';
          showToast(data.detail, variant);
        } catch {
          showToast('テストイベント送信中に通信エラーが発生しました。', 'error');
        }
      });
    });
  }

  // 初期化実行
  initObsUrl();
  initTheme();
  bindEvents();
  fetchInitialState();
  connectWebSocket();
})();
