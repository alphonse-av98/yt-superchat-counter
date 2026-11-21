(() => {
  'use strict';

  const CONFETTI_COLORS = [
    '#ff8dc7', // パステルピンク
    '#ff5ca8', // ストロベリーピンク
    '#c792ea', // ラベンダー
    '#89cff0', // ベビーブルー
    '#fde047', // キラキラレモン
    '#ffd166', // シャンパンゴールド
    '#99f6e4', // パステルミント
    '#ffffff', // スパークルホワイト
  ];

  let canvas = null;
  let ctx = null;
  let particles = [];
  let animId = null;
  let lastTime = 0;

  // 目標達成中の常時紙吹雪フラグ・スポーン蓄積時間
  let continuousEnabled = false;
  let spawnAccumulator = 0;

  /**
   * 紙吹雪描画用の最前面透過Canvasを準備する（オーバーレイの上に被せて表示）
   */
  function ensureCanvas() {
    if (!canvas) {
      canvas = document.getElementById('confetti-canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'confetti-canvas';
        canvas.style.position = 'fixed';
        canvas.style.inset = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '9999';
        document.body.appendChild(canvas);
      }
      ctx = canvas.getContext('2d');
      window.addEventListener('resize', resizeCanvas);
    }
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !ctx) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 達成時の初回クラッカー風バーストを生成する
   */
  function spawnBurst({ originX, originY, count, angleMin, angleMax, speedScale }) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sizeBase = Math.max(6, Math.min(11, Math.min(w, h) * 0.045));

    for (let i = 0; i < count; i++) {
      const angle = angleMin + Math.random() * (angleMax - angleMin);
      const speed = (200 + Math.random() * 320) * speedScale;
      const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      const shape = Math.random() < 0.78 ? 'rect' : 'circle';

      particles.push({
        mode: 'burst',
        x: originX + (Math.random() - 0.5) * 24,
        y: originY + (Math.random() - 0.5) * 16,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        width: sizeBase * (0.7 + Math.random() * 0.75),
        height: sizeBase * (0.38 + Math.random() * 0.45),
        color,
        shape,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 10,
        tilt: Math.random() * Math.PI * 2,
        tiltSpeed: 5 + Math.random() * 7,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 2.5 + Math.random() * 3,
        life: 0,
        maxLife: 2.4 + Math.random() * 1.3,
      });
    }
  }

  /**
   * 画面上部からひらひら舞い続ける紙吹雪1枚を生成する
   */
  function spawnShowerParticle(initialRandomY = false) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sizeBase = Math.max(6.5, Math.min(11.5, Math.min(w, h) * 0.042));
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const shape = Math.random() < 0.8 ? 'rect' : 'circle';

    particles.push({
      mode: 'shower',
      x: Math.random() * w,
      y: initialRandomY ? Math.random() * h : -14 - Math.random() * 20,
      vx: (Math.random() - 0.5) * 26,
      vy: Math.max(38, Math.min(105, h * 0.24)) * (0.75 + Math.random() * 0.55),
      width: sizeBase * (0.75 + Math.random() * 0.65),
      height: sizeBase * (0.4 + Math.random() * 0.42),
      color,
      shape,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 5.5,
      tilt: Math.random() * Math.PI * 2,
      tiltSpeed: 4 + Math.random() * 5,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 2 + Math.random() * 2.4,
      life: 0,
      maxLife: 12,
    });
  }

  /**
   * アニメーションループ開始
   */
  function startLoop() {
    if (animId === null) {
      lastTime = performance.now();
      animId = requestAnimationFrame(tick);
    }
  }

  /**
   * 毎フレームの描画・物理更新
   */
  function tick(now) {
    if (!ctx || !canvas) {
      animId = null;
      return;
    }

    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;

    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    // 常時モードONの間、一定ペースで画面上部から紙吹雪を補充する
    if (continuousEnabled) {
      const targetRate = w < 640 ? 11 : 18; // 1秒あたりの生成枚数
      const maxShowerParticles = w < 640 ? 55 : 95;
      spawnAccumulator += dt * targetRate;
      while (spawnAccumulator >= 1) {
        spawnAccumulator -= 1;
        if (particles.length < maxShowerParticles + 80) {
          spawnShowerParticle(false);
        }
      }
    }

    const burstGravity = Math.max(240, Math.min(520, h * 1.1));
    const drag = Math.pow(0.985, dt * 60);
    const nextParticles = [];

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.life += dt;

      if (p.mode === 'burst') {
        if (p.life >= p.maxLife) {
          continue;
        }
        p.vx *= drag;
        p.vy = p.vy * drag + burstGravity * dt;
        p.wobble += p.wobbleSpeed * dt;
        p.x += (p.vx + Math.sin(p.wobble) * 32) * dt;
        p.y += p.vy * dt;
      } else {
        // シャワー型：一定の軽やかな速度でひらひら舞い落ちる
        p.wobble += p.wobbleSpeed * dt;
        p.x += (p.vx + Math.sin(p.wobble) * 28) * dt;
        p.y += p.vy * dt;
        // 横にはみ出たら反対側から自然に戻す
        if (p.x < -20) {
          p.x = w + 16;
        } else if (p.x > w + 20) {
          p.x = -16;
        }
      }

      p.rotation += p.rotationSpeed * dt;
      p.tilt += p.tiltSpeed * dt;

      if (p.y > h + 28) {
        continue;
      }

      let alpha = 0.94;
      if (p.mode === 'burst') {
        const lifeRatio = p.life / p.maxLife;
        alpha = lifeRatio > 0.7 ? Math.max(0, 1 - (lifeRatio - 0.7) / 0.3) : 0.96;
      } else if (p.y > h * 0.82) {
        // 下端付近で自然にフェードアウト
        alpha = Math.max(0, 0.94 * (1 - (p.y - h * 0.82) / (h * 0.22)));
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;

      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.height * 0.65, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const scaleY = Math.cos(p.tilt);
        ctx.scale(1, Math.abs(scaleY) < 0.15 ? 0.15 : scaleY);
        ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
      }
      ctx.restore();

      nextParticles.push(p);
    }

    particles = nextParticles;

    if (particles.length > 0 || continuousEnabled) {
      animId = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, w, h);
      animId = null;
    }
  }

  /**
   * 目標達成・テスト用の華やかなバーストを発火する
   */
  function launchConfetti() {
    ensureCanvas();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isCompact = w < 640 || h < 280;
    const speedScale = isCompact ? 0.62 : 1.0;
    const sideCount = isCompact ? 32 : 50;
    const centerCount = isCompact ? 38 : 64;

    spawnBurst({
      originX: w * 0.12,
      originY: h * 0.78,
      count: sideCount,
      angleMin: -Math.PI * 0.44,
      angleMax: -Math.PI * 0.12,
      speedScale,
    });
    spawnBurst({
      originX: w * 0.88,
      originY: h * 0.78,
      count: sideCount,
      angleMin: -Math.PI * 0.88,
      angleMax: -Math.PI * 0.56,
      speedScale,
    });

    setTimeout(() => {
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      spawnBurst({
        originX: cw * 0.5,
        originY: ch * 0.65,
        count: centerCount,
        angleMin: -Math.PI * 0.85,
        angleMax: -Math.PI * 0.15,
        speedScale: speedScale * 0.95,
      });
      startLoop();
    }, 240);

    startLoop();
  }

  /**
   * オーバーレイ上に紙吹雪を継続表示するモードの ON / OFF
   */
  function setContinuousConfetti(enabled) {
    const next = Boolean(enabled);
    if (next === continuousEnabled) {
      return;
    }
    continuousEnabled = next;
    spawnAccumulator = 0;

    if (continuousEnabled) {
      ensureCanvas();
      // 開始直後から画面全体にふんわり紙吹雪が見えるよう初期配置する
      const initialCount = window.innerWidth < 640 ? 22 : 36;
      for (let i = 0; i < initialCount; i++) {
        spawnShowerParticle(true);
      }
      startLoop();
    }
  }

  window.launchConfetti = launchConfetti;
  window.setContinuousConfetti = setContinuousConfetti;
})();
