/* ============================================================
   Manga Letterer — client-side balloon text placement tool
   No build step, no server. Runs entirely in the browser.
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- DOM refs ---------------- */
  const imageInput   = document.getElementById("imageInput");
  const imageInfo     = document.getElementById("imageInfo");
  const imageDropLabel= document.getElementById("imageDropLabel");
  const fontInput     = document.getElementById("fontInput");
  const fontDropLabel = document.getElementById("fontDropLabel");
  const textDirSel    = document.getElementById("textDir");
  const textCaseSel   = document.getElementById("textCase");
  const zoomRange     = document.getElementById("zoomRange");
  const zoomVal       = document.getElementById("zoomVal");
  const zoomInBtn      = document.getElementById("zoomIn");
  const zoomOutBtn     = document.getElementById("zoomOut");
  const zoomFitBtn     = document.getElementById("zoomFit");
  const workspace      = document.getElementById("workspace");
  const canvasScroll   = document.getElementById("canvasScroll");
  const canvasStage    = document.getElementById("canvasStage");
  const imageCanvas    = document.getElementById("imageCanvas");
  const overlayCanvas  = document.getElementById("overlayCanvas");
  const emptyState     = document.getElementById("emptyState");
  const toolButtons    = Array.from(document.querySelectorAll(".tool-btn"));
  const toolHint       = document.getElementById("toolHint");
  const balloonList    = document.getElementById("balloonList");
  const balloonCount   = document.getElementById("balloonCount");
  const balloonEmptyHint = document.getElementById("balloonEmptyHint");
  const btnExport      = document.getElementById("btnExport");
  const polyToast       = document.getElementById("polyToast");

  const ictx = imageCanvas.getContext("2d");
  const octx = overlayCanvas.getContext("2d");

  /* ---------------- State ---------------- */
  const state = {
    img: null,
    naturalW: 0,
    naturalH: 0,
    zoom: 1,
    tool: "pan",
    balloons: [],       // {id, type, points|ellipse, text, ok}
    nextId: 1,
    selectedId: null,
    fontFamily: '"BalloonFont", "Comic Sans MS", "Segoe Print", cursive, sans-serif',
    dir: "rtl",
    textCase: "none",
    drag: null,          // active pointer interaction
    polygonDraft: null,  // {points:[...]}
    renderPending: false,
  };

  const TOOL_LABELS = {
    pan: "برای پیمایش تصویر، آن را بکشید (روی موبایل با انگشت اسکرول کنید).",
    ellipse: "برای رسم بالون بیضی، از یک گوشه تا گوشهٔ دیگر بکشید.",
    polygon: "برای رسم بالون آزاد، نقطه‌به‌نقطه لمس/کلیک کنید و با دکمهٔ «پایان شکل» تمام کنید.",
    select: "روی یک بالون کلیک کنید تا انتخاب شود؛ سپس بکشید تا جابه‌جا شود.",
  };

  /* ================= Image loading ================= */
  imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadImageFile(file);
  });

  ["dragover", "dragenter"].forEach(ev =>
    document.getElementById("imageDropLabel").parentElement.addEventListener(ev, (e) => {
      e.preventDefault();
    })
  );
  document.getElementById("imageDropLabel").parentElement.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) loadImageFile(file);
  });

  function loadImageFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      setImage(img, file.name);
    };
    img.onerror = () => {
      alert("بارگذاری تصویر ناموفق بود. لطفاً فایل دیگری امتحان کنید.");
    };
    img.src = url;
  }

  function setImage(img, name) {
    state.img = img;
    state.naturalW = img.naturalWidth;
    state.naturalH = img.naturalHeight;
    state.balloons = [];
    state.selectedId = null;

    imageCanvas.width = state.naturalW;
    imageCanvas.height = state.naturalH;
    overlayCanvas.width = state.naturalW;
    overlayCanvas.height = state.naturalH;

    imageDropLabel.textContent = name || "تصویر بارگذاری شد";
    document.getElementById("imageDropLabel").parentElement.classList.add("has-file");
    imageInfo.textContent = `${state.naturalW} × ${state.naturalH} پیکسل`;
    emptyState.style.display = "none";
    btnExport.disabled = false;

    renderBalloonListEmpty();
    scheduleRender();
    fitZoomToWidth();
  }

  /* ================= Custom font ================= */
  fontInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const face = new FontFace("BalloonFont", buf);
      await face.load();
      document.fonts.add(face);
      fontDropLabel.textContent = file.name;
      document.getElementById("fontDropLabel").parentElement.classList.add("has-file");
      scheduleRender();
    } catch (err) {
      alert("این فایل فونت قابل بارگذاری نبود.");
    }
  });

  textDirSel.addEventListener("change", () => { state.dir = textDirSel.value; scheduleRender(); });
  textCaseSel.addEventListener("change", () => { state.textCase = textCaseSel.value; scheduleRender(); });

  /* ================= Tool selection ================= */
  toolButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (state.polygonDraft) cancelPolygonDraft();
      toolButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.tool = btn.dataset.tool;
      toolHint.textContent = TOOL_LABELS[state.tool] || "";
      overlayCanvas.style.pointerEvents = state.tool === "pan" ? "none" : "auto";
      polyToast.hidden = true;
      drawOverlay();
    });
  });
  toolButtons[0].classList.add("active");
  overlayCanvas.style.pointerEvents = "none";

  /* ================= Zoom ================= */
  function applyZoomToDom() {
    const w = state.naturalW * state.zoom;
    const h = state.naturalH * state.zoom;
    canvasStage.style.width = w + "px";
    canvasStage.style.height = h + "px";
    [imageCanvas, overlayCanvas].forEach(c => {
      c.style.width = w + "px";
      c.style.height = h + "px";
    });
    zoomVal.textContent = Math.round(state.zoom * 100) + "%";
    zoomRange.value = Math.round(state.zoom * 100);
  }
  function setZoom(z) {
    state.zoom = Math.min(2, Math.max(0.05, z));
    applyZoomToDom();
  }
  function fitZoomToWidth() {
    if (!state.naturalW) return;
    const available = workspace.clientWidth - 48;
    setZoom(Math.min(1, available / state.naturalW));
  }
  zoomRange.addEventListener("input", () => setZoom(zoomRange.value / 100));
  zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.1));
  zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.1));
  zoomFitBtn.addEventListener("click", fitZoomToWidth);
  window.addEventListener("resize", () => { if (state.naturalW) applyZoomToDom(); });

  /* ================= Coordinate helpers ================= */
  function clientToCanvas(clientX, clientY) {
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = state.naturalW / rect.width;
    const scaleY = state.naturalH / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  /* ================= Balloon geometry helpers ================= */
  function getBBox(b) {
    if (b.type === "ellipse") {
      return {
        minX: b.cx - b.rx, maxX: b.cx + b.rx,
        minY: b.cy - b.ry, maxY: b.cy + b.ry,
        width: b.rx * 2, height: b.ry * 2,
      };
    }
    const xs = b.points.map(p => p.x), ys = b.points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  function chordWidthAt(b, y) {
    if (b.type === "ellipse") {
      const t = 1 - Math.pow((y - b.cy) / b.ry, 2);
      if (t <= 0) return 0;
      return 2 * b.rx * Math.sqrt(t);
    }
    // polygon: find intersections of horizontal ray with edges
    const pts = b.points;
    const xsHit = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      if ((a.y <= y && c.y > y) || (c.y <= y && a.y > y)) {
        const t = (y - a.y) / (c.y - a.y);
        xsHit.push(a.x + t * (c.x - a.x));
      }
    }
    if (xsHit.length < 2) return 0;
    return Math.max(...xsHit) - Math.min(...xsHit);
  }

  function moveBalloon(b, dx, dy) {
    if (b.type === "ellipse") { b.cx += dx; b.cy += dy; }
    else b.points.forEach(p => { p.x += dx; p.y += dy; });
  }

  function pointInBalloon(b, x, y) {
    const box = getBBox(b);
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) return false;
    if (b.type === "ellipse") {
      return Math.pow((x - b.cx) / b.rx, 2) + Math.pow((y - b.cy) / b.ry, 2) <= 1;
    }
    // ray casting for polygon
    let inside = false;
    const pts = b.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /* ================= Text fitting ================= */
  function wrapAtFontSize(ctx, b, text, fontSize, opts) {
    const box = getBBox(b);
    const lineHeight = fontSize * 1.22;
    const usableH = box.height * 0.82;
    const maxLines = Math.max(1, Math.floor(usableH / lineHeight));
    ctx.font = `${fontSize}px ${opts.fontFamily}`;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return { lines: [], fontSize, lineHeight, fits: true, maxLines, box };

    // Pass 1: estimate row widths assuming `maxLines` evenly spaced rows
    function rowsCenteredAt(n) {
      const rows = [];
      const top = box.minY + (box.height - n * lineHeight) / 2 + lineHeight / 2;
      for (let i = 0; i < n; i++) {
        const y = top + i * lineHeight;
        rows.push({ y, width: chordWidthAt(b, y) * 0.78 });
      }
      return rows;
    }

    function greedyWrap(rows) {
      const lines = [];
      let cur = "";
      let rowIdx = 0;
      for (let i = 0; i < words.length; i++) {
        if (rowIdx >= rows.length) return null; // overflow
        const candidate = cur ? cur + " " + words[i] : words[i];
        const w = ctx.measureText(candidate).width;
        const rowW = rows[rowIdx] ? rows[rowIdx].width : 0;
        if (w <= rowW || !cur) {
          // word fits on current line, or line is still empty (force-place even if oversized)
          cur = candidate;
        } else {
          // doesn't fit: push current line, start a new row with this word
          lines.push({ text: cur, y: rows[rowIdx].y });
          rowIdx++;
          if (rowIdx >= rows.length) return null;
          cur = words[i];
        }
      }
      if (cur) {
        if (rowIdx >= rows.length) return null;
        lines.push({ text: cur, y: rows[rowIdx].y });
      }
      return lines;
    }

    let lines = greedyWrap(rowsCenteredAt(maxLines));
    if (!lines) return { lines: null, fontSize, lineHeight, fits: false, maxLines, box };

    // Pass 2: re-center rows using the actual number of lines used, for tighter vertical centering
    const k = lines.length;
    if (k >= 1 && k < maxLines) {
      const lines2 = greedyWrap(rowsCenteredAt(k));
      if (lines2) lines = lines2;
    }
    return { lines, fontSize, lineHeight, fits: true, maxLines, box };
  }

  function fitTextToShape(ctx, b, rawText, opts) {
    let text = rawText || "";
    if (opts.textCase === "upper") text = text.toUpperCase();
    if (!text.trim()) return { lines: [], fontSize: 16, fits: true };

    const box = getBBox(b);
    let lo = 8;
    let hi = Math.max(lo, Math.floor(Math.min(box.height * 0.6, box.width * 0.5, 140)));
    let best = null;

    // Linear scan from hi down to lo, first success wins (robust vs. non-monotonic wraps)
    for (let fs = hi; fs >= lo; fs -= 2) {
      const res = wrapAtFontSize(ctx, b, text, fs, opts);
      if (res.fits) { best = res; break; }
    }
    if (!best) {
      // even smallest size doesn't fit: use smallest and allow overflow, flag warn
      best = wrapAtFontSize(ctx, b, text, lo, opts);
      if (!best.fits) {
        // force a naive wrap so at least something renders
        best = { lines: text.split(/\s+/).map((w, i) => ({ text: w, y: box.minY + 10 + i * (lo * 1.22) })), fontSize: lo, lineHeight: lo * 1.22 };
      }
      best.fits = false;
    }
    best.fontSize = best.fontSize || best.fs;
    return best;
  }

  /* ================= Rendering ================= */
  function scheduleRender() {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(() => {
      state.renderPending = false;
      renderImageCanvas();
      drawOverlay();
      updateBalloonListFits();
    });
  }

  function renderImageCanvas() {
    if (!state.img) return;
    ictx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
    ictx.drawImage(state.img, 0, 0);

    const opts = { fontFamily: state.fontFamily, textCase: state.textCase };
    ictx.textBaseline = "middle";
    ictx.fillStyle = "#000";
    ictx.direction = state.dir;
    ictx.textAlign = "center";

    state.balloons.forEach(b => {
      const fit = fitTextToShape(ictx, b, b.text, opts);
      b.ok = fit.fits !== false;
      if (!fit.lines || !fit.lines.length) return;
      const box = getBBox(b);
      const cx = (box.minX + box.maxX) / 2;
      ictx.font = `${fit.fontSize}px ${state.fontFamily}`;
      fit.lines.forEach(line => {
        ictx.fillText(line.text, cx, line.y);
      });
    });
  }

  function drawOverlay() {
    octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!state.img) return;

    state.balloons.forEach(b => {
      const selected = b.id === state.selectedId;
      drawShapeOutline(b, selected ? "#e0483e" : "rgba(224,72,62,0.45)", selected ? 3 : 1.5);
      if (selected && b.type === "ellipse") drawEllipseHandle(b);
      if (selected && b.type === "polygon") b.points.forEach(p => drawHandle(p.x, p.y));
    });

    if (state.polygonDraft) {
      const pts = state.polygonDraft.points;
      octx.strokeStyle = "#e0483e";
      octx.lineWidth = 2;
      octx.beginPath();
      pts.forEach((p, i) => i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y));
      octx.stroke();
      pts.forEach((p, i) => drawHandle(p.x, p.y, i === 0));
    }
  }

  function drawShapeOutline(b, color, lw) {
    octx.strokeStyle = color;
    octx.lineWidth = lw;
    octx.setLineDash([8, 6]);
    octx.beginPath();
    if (b.type === "ellipse") {
      octx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
    } else {
      b.points.forEach((p, i) => i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y));
      octx.closePath();
    }
    octx.stroke();
    octx.setLineDash([]);
  }
  function drawHandle(x, y, first) {
    octx.fillStyle = first ? "#ffd166" : "#ffffff";
    octx.strokeStyle = "#e0483e";
    octx.lineWidth = 2;
    octx.beginPath();
    octx.arc(x, y, 7, 0, Math.PI * 2);
    octx.fill();
    octx.stroke();
  }
  function drawEllipseHandle(b) {
    drawHandle(b.cx + b.rx, b.cy + b.ry);
  }

  /* ================= Pointer interaction ================= */
  overlayCanvas.addEventListener("pointerdown", onPointerDown);
  overlayCanvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  function onPointerDown(e) {
    if (!state.img) return;
    const p = clientToCanvas(e.clientX, e.clientY);

    if (state.tool === "ellipse") {
      state.drag = { mode: "new-ellipse", start: p };
    } else if (state.tool === "polygon") {
      if (!state.polygonDraft) {
        state.polygonDraft = { points: [p] };
        polyToast.hidden = false;
        updatePolyToast();
      } else {
        const first = state.polygonDraft.points[0];
        const distToFirst = Math.hypot(p.x - first.x, p.y - first.y);
        const closeThresh = 16 / state.zoom;
        if (state.polygonDraft.points.length >= 3 && distToFirst < closeThresh) {
          finishPolygonDraft();
        } else {
          state.polygonDraft.points.push(p);
          updatePolyToast();
        }
      }
      drawOverlay();
    } else if (state.tool === "select") {
      // check resize handle first
      const sel = state.balloons.find(b => b.id === state.selectedId);
      if (sel && sel.type === "ellipse") {
        const hx = sel.cx + sel.rx, hy = sel.cy + sel.ry;
        if (Math.hypot(p.x - hx, p.y - hy) < 14 / state.zoom) {
          state.drag = { mode: "resize-ellipse", balloon: sel };
          return;
        }
      }
      if (sel && sel.type === "polygon") {
        const idx = sel.points.findIndex(pt => Math.hypot(pt.x - p.x, pt.y - p.y) < 14 / state.zoom);
        if (idx >= 0) {
          state.drag = { mode: "drag-vertex", balloon: sel, idx };
          return;
        }
      }
      // otherwise hit-test balloons (topmost first)
      const hit = [...state.balloons].reverse().find(b => pointInBalloon(b, p.x, p.y));
      if (hit) {
        selectBalloon(hit.id);
        state.drag = { mode: "move", balloon: hit, last: p };
      } else {
        selectBalloon(null);
      }
    }
  }

  function onPointerMove(e) {
    if (!state.img) return;
    const p = clientToCanvas(e.clientX, e.clientY);

    if (state.tool === "ellipse" && state.drag && state.drag.mode === "new-ellipse") {
      const s = state.drag.start;
      octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      redrawExistingOutlines();
      const cx = (s.x + p.x) / 2, cy = (s.y + p.y) / 2;
      const rx = Math.abs(p.x - s.x) / 2, ry = Math.abs(p.y - s.y) / 2;
      octx.strokeStyle = "#e0483e";
      octx.lineWidth = 2;
      octx.beginPath();
      octx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      octx.stroke();
      return;
    }

    if (state.tool === "polygon" && state.polygonDraft) {
      drawOverlay();
      const pts = state.polygonDraft.points;
      const last = pts[pts.length - 1];
      octx.strokeStyle = "rgba(224,72,62,0.6)";
      octx.setLineDash([4, 4]);
      octx.beginPath();
      octx.moveTo(last.x, last.y);
      octx.lineTo(p.x, p.y);
      octx.stroke();
      octx.setLineDash([]);
      return;
    }

    if (state.drag) {
      const d = state.drag;
      if (d.mode === "move") {
        moveBalloon(d.balloon, p.x - d.last.x, p.y - d.last.y);
        d.last = p;
        scheduleRender();
      } else if (d.mode === "resize-ellipse") {
        d.balloon.rx = Math.max(10, Math.abs(p.x - d.balloon.cx));
        d.balloon.ry = Math.max(10, Math.abs(p.y - d.balloon.cy));
        scheduleRender();
      } else if (d.mode === "drag-vertex") {
        d.balloon.points[d.idx] = p;
        scheduleRender();
      }
    }
  }

  function onPointerUp(e) {
    if (state.drag && state.drag.mode === "new-ellipse") {
      const s = state.drag.start;
      const p = clientToCanvas(e.clientX, e.clientY);
      const rx = Math.abs(p.x - s.x) / 2, ry = Math.abs(p.y - s.y) / 2;
      if (rx > 8 && ry > 8) {
        const b = {
          id: state.nextId++,
          type: "ellipse",
          cx: (s.x + p.x) / 2, cy: (s.y + p.y) / 2,
          rx, ry, text: "",
        };
        state.balloons.push(b);
        selectBalloon(b.id);
        addBalloonCard(b);
        switchTool("select");
        focusBalloonTextarea(b.id);
      }
    }
    state.drag = null;
    scheduleRender();
  }

  function redrawExistingOutlines() {
    state.balloons.forEach(b => drawShapeOutline(b, b.id === state.selectedId ? "#e0483e" : "rgba(224,72,62,0.45)", 1.5));
  }

  /* ---- polygon helpers ---- */
  function updatePolyToast() {
    const n = state.polygonDraft.points.length;
    polyToast.innerHTML = n < 3
      ? "نقطه بعدی را اضافه کنید (حداقل ۳ نقطه لازم است)"
      : 'برای پایان، روی نقطهٔ زرد اول بزنید یا <button id="finishPolyBtn" class="btn btn-primary" style="padding:3px 10px;margin-inline-start:8px;">پایان شکل</button>';
    const fb = document.getElementById("finishPolyBtn");
    if (fb) fb.addEventListener("click", finishPolygonDraft);
  }
  function finishPolygonDraft() {
    if (!state.polygonDraft || state.polygonDraft.points.length < 3) { cancelPolygonDraft(); return; }
    const b = { id: state.nextId++, type: "polygon", points: state.polygonDraft.points, text: "" };
    state.balloons.push(b);
    state.polygonDraft = null;
    polyToast.hidden = true;
    selectBalloon(b.id);
    addBalloonCard(b);
    switchTool("select");
    focusBalloonTextarea(b.id);
    scheduleRender();
  }
  function cancelPolygonDraft() {
    state.polygonDraft = null;
    polyToast.hidden = true;
    drawOverlay();
  }
  function switchTool(name) {
    toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === name));
    state.tool = name;
    toolHint.textContent = TOOL_LABELS[name] || "";
    overlayCanvas.style.pointerEvents = name === "pan" ? "none" : "auto";
  }

  /* ================= Balloon list panel ================= */
  function renderBalloonListEmpty() {
    balloonList.innerHTML = "";
    balloonList.appendChild(balloonEmptyHint);
    balloonEmptyHint.style.display = state.balloons.length ? "none" : "block";
    balloonCount.textContent = toPersianDigits(state.balloons.length);
  }

  function addBalloonCard(b) {
    balloonEmptyHint.style.display = "none";
    const card = document.createElement("div");
    card.className = "balloon-card";
    card.dataset.id = b.id;
    card.innerHTML = `
      <div class="balloon-card-head">
        <b>بالون #${toPersianDigits(indexOfBalloon(b.id) + 1)}</b>
        <span>
          <span class="fit-badge ok" data-role="fit">مناسب</span>
          <button class="icon-btn" data-action="focus" title="نمایش در بوم">◎</button>
          <button class="icon-btn" data-action="delete" title="حذف">✕</button>
        </span>
      </div>
      <textarea placeholder="متن ترجمه‌شده…" data-role="text">${escapeHtml(b.text)}</textarea>
    `;
    balloonList.appendChild(card);
    balloonCount.textContent = toPersianDigits(state.balloons.length);

    const ta = card.querySelector("textarea");
    ta.addEventListener("input", () => {
      b.text = ta.value;
      scheduleRender();
    });
    card.addEventListener("click", (e) => {
      if (e.target === ta) { selectBalloon(b.id); return; }
      const action = e.target.dataset.action;
      if (action === "delete") deleteBalloon(b.id);
      if (action === "focus") { selectBalloon(b.id); scrollToBalloon(b); }
    });
  }

  function indexOfBalloon(id) { return state.balloons.findIndex(b => b.id === id); }

  function deleteBalloon(id) {
    state.balloons = state.balloons.filter(b => b.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    rebuildBalloonList();
    scheduleRender();
  }

  function rebuildBalloonList() {
    balloonList.innerHTML = "";
    balloonList.appendChild(balloonEmptyHint);
    if (!state.balloons.length) {
      balloonEmptyHint.style.display = "block";
      balloonCount.textContent = "۰";
      return;
    }
    balloonEmptyHint.style.display = "none";
    state.balloons.forEach(b => addBalloonCard(b));
  }

  function selectBalloon(id) {
    state.selectedId = id;
    Array.from(balloonList.querySelectorAll(".balloon-card")).forEach(card => {
      card.style.borderColor = Number(card.dataset.id) === id ? "#e0483e" : "";
    });
    drawOverlay();
  }

  function focusBalloonTextarea(id) {
    const card = balloonList.querySelector(`.balloon-card[data-id="${id}"]`);
    if (card) {
      const ta = card.querySelector("textarea");
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTimeout(() => ta.focus(), 150);
    }
  }

  function scrollToBalloon(b) {
    const box = getBBox(b);
    const cx = (box.minX + box.maxX) / 2 * state.zoom;
    const cy = (box.minY + box.maxY) / 2 * state.zoom;
    canvasScroll.scrollTo({
      left: cx - canvasScroll.clientWidth / 2,
      top: cy - canvasScroll.clientHeight / 2,
      behavior: "smooth",
    });
  }

  function updateBalloonListFits() {
    state.balloons.forEach(b => {
      const card = balloonList.querySelector(`.balloon-card[data-id="${b.id}"]`);
      if (!card) return;
      const badge = card.querySelector('[data-role="fit"]');
      if (!badge) return;
      if (b.ok === false) {
        badge.textContent = "جا نمی‌شود";
        badge.className = "fit-badge warn";
      } else {
        badge.textContent = "مناسب";
        badge.className = "fit-badge ok";
      }
    });
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
  function toPersianDigits(n) {
    return String(n).replace(/[0-9]/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);
  }

  /* ================= Export ================= */
  btnExport.addEventListener("click", () => {
    if (!state.img) return;
    renderImageCanvas(); // ensure fully up to date, no overlay included
    imageCanvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "translated-page.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, "image/png");
  });

  /* ================= Keyboard ================= */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.polygonDraft) cancelPolygonDraft();
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId && document.activeElement.tagName !== "TEXTAREA") {
      deleteBalloon(state.selectedId);
    }
  });

})();
