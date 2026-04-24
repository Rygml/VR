'use strict';

// ─── WebGL globals ────────────────────────────────────────────────────────────
let gl;
let surfaceU, surfaceV, surfaceFill;
let sphereModel;
let shProgram;
let sphereProgram;
let spaceball;

// ─── Stereo parameters ────────────────────────────────────────────────────────
let eyeSeparation = 0.5;
let convergence   = 10.0;
let fov           = 45.0;
let nearClipping  = 8.0;
const FAR_CLIPPING = 20.0;

// ─── Surface constants ────────────────────────────────────────────────────────
const SCALE           = 0.35;
const P_MIN           = -Math.PI / 2;
const P_MAX           =  Math.PI / 2;
const LINES           = 30;
const SAMPLES         = 60;
const MESH_SIZE       = 45;
const DRAW_BOTH_SIGNS = true;

// ─── Sound source orbit ───────────────────────────────────────────────────────
const ORBIT_RADIUS = 1.8;
let sourcePos = { x: 0, y: 0, z: -ORBIT_RADIUS };

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR  (Variant 16: ZXY orientation → sound source position)
// ═══════════════════════════════════════════════════════════════════════════════
let sensorConnected = false;
let wsConnection    = null;

function anglesTo3D(azimuth, pitch) {
    return {
        x: ORBIT_RADIUS * Math.cos(pitch) * Math.sin(azimuth),
        y: ORBIT_RADIUS * Math.sin(pitch),
        z: ORBIT_RADIUS * Math.cos(pitch) * Math.cos(azimuth)
    };
}

function connectSensor(ip, port) {
    if (wsConnection) { wsConnection.close(); wsConnection = null; }
    const url = `ws://${ip}:${port}/`;
    setSensorStatus('connecting', `Connecting to ${url}…`);
    try { wsConnection = new WebSocket(url); }
    catch (e) { setSensorStatus('error', `Invalid address: ${e.message}`); return; }

    wsConnection.onopen = () => {
        sensorConnected = true;
        setSensorStatus('ok', `Connected → ${url}`);
    };
    wsConnection.onmessage = (evt) => {
        try {
            const d = JSON.parse(evt.data);
            sourcePos = anglesTo3D(d.azimuth ?? 0, d.pitch ?? 0);
            updatePannerPosition();
        } catch (_) {}
    };
    wsConnection.onerror = () =>
        setSensorStatus('error', 'Connection error. Is the bridge running?');
    wsConnection.onclose = () => {
        sensorConnected = false;
        wsConnection    = null;
        setSensorStatus('idle', 'Disconnected');
    };
}

function disconnectSensor() {
    if (wsConnection) wsConnection.close();
    sensorConnected = false;
    setSensorStatus('idle', 'Disconnected');
}

function setSensorStatus(state, msg) {
    const el = document.getElementById('sensorStatus');
    if (!el) return;
    const icons  = { ok:'📡', connecting:'⏳', error:'❌', idle:'🔌' };
    const colors = { ok:'#00FF99', connecting:'#FFD700', error:'#FF4444', idle:'#888' };
    el.textContent = (icons[state] || '') + ' ' + msg;
    el.style.color = colors[state] || '#888';
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEB AUDIO
// ═══════════════════════════════════════════════════════════════════════════════
let audioCtx      = null;
let audioSource   = null;
let panner        = null;
let filterNode    = null;
let filterEnabled = false;
let audioReady    = false;
let audioBuffer   = null;

function loadAudioFile(file) {
    setAudioStatus('⏳ Loading audio…');

    // Close previous AudioContext if exists
    if (audioCtx) {
        try { audioCtx.close(); } catch (_) {}
        audioCtx = null;
        audioSource = null;
        panner = null;
        filterNode = null;
        audioReady = false;
    }

    // Use FileReader to read as ArrayBuffer (works without a server)
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            audioBuffer = await audioCtx.decodeAudioData(e.target.result);

            // ── PannerNode (HRTF) ─────────────────────────────────────────────
            panner = audioCtx.createPanner();
            panner.panningModel   = 'HRTF';
            panner.distanceModel  = 'inverse';
            panner.refDistance    = 1;
            panner.maxDistance    = 20;
            panner.rolloffFactor  = 1;
            panner.coneInnerAngle = 360;
            panner.coneOuterAngle = 360;
            panner.coneOuterGain  = 0;

            // ── BiquadFilterNode — Low-Pass (Variant 16) ──────────────────────
            filterNode = audioCtx.createBiquadFilter();
            filterNode.type            = 'lowpass';
            filterNode.frequency.value = parseFloat(document.getElementById('filterFreq').value);
            filterNode.Q.value         = 1.2;

            // ── Listener at origin ────────────────────────────────────────────
            const L = audioCtx.listener;
            if (L.positionX) {
                L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0;
                L.forwardX.value  = 0; L.forwardY.value  = 0; L.forwardZ.value  = -1;
                L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
            } else {
                L.setPosition(0, 0, 0);
                L.setOrientation(0, 0, -1, 0, 1, 0);
            }

            updatePannerPosition();

            audioReady = true;
            setAudioStatus('✅ Audio ready — press Play');
            document.getElementById('btnPlay').disabled = false;
        } catch (err) {
            setAudioStatus(`❌ Decode error: ${err.message}`);
            console.error('[audio]', err);
        }
    };
    reader.onerror = () => setAudioStatus('❌ File read error');
    reader.readAsArrayBuffer(file);
}

function buildAudioGraph() {
    if (!audioSource || !panner || !filterNode) return;
    try { audioSource.disconnect(); } catch (_) {}
    try { panner.disconnect();      } catch (_) {}
    try { filterNode.disconnect();  } catch (_) {}

    audioSource.connect(panner);
    if (filterEnabled) {
        panner.connect(filterNode);
        filterNode.connect(audioCtx.destination);
    } else {
        panner.connect(audioCtx.destination);
    }
}

function playAudio() {
    if (!audioReady || !audioCtx) return;
    if (audioCtx.state === 'suspended') { audioCtx.resume(); }

    if (audioSource) {
        try { audioSource.stop(); audioSource.disconnect(); } catch (_) {}
    }

    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuffer;
    audioSource.loop   = true;
    buildAudioGraph();
    audioSource.start(0);

    setAudioStatus('🎵 Playing');
    const btn = document.getElementById('btnPlay');
    btn.textContent = '⏸ Pause';
    btn.onclick = pauseAudio;
}

function pauseAudio() {
    if (!audioCtx) return;
    audioCtx.suspend();
    setAudioStatus('⏸ Paused');
    const btn = document.getElementById('btnPlay');
    btn.textContent = '▶ Resume';
    btn.onclick = resumeAudio;
}

function resumeAudio() {
    if (!audioCtx) return;
    audioCtx.resume();
    setAudioStatus('🎵 Playing');
    const btn = document.getElementById('btnPlay');
    btn.textContent = '⏸ Pause';
    btn.onclick = pauseAudio;
}

function toggleFilter(enabled) {
    filterEnabled = enabled;
    if (!audioReady || !audioSource) return;
    buildAudioGraph();
}

function updatePannerPosition() {
    if (!panner) return;
    if (panner.positionX) {
        panner.positionX.value = sourcePos.x;
        panner.positionY.value = sourcePos.y;
        panner.positionZ.value = sourcePos.z;
    } else {
        panner.setPosition(sourcePos.x, sourcePos.y, sourcePos.z);
    }
}

function setAudioStatus(msg) {
    const el = document.getElementById('audioStatus');
    if (el) el.textContent = msg;
}

function updateFilterStatus() {
    const freq = document.getElementById('filterFreq').value;
    const el   = document.getElementById('filterStatus');
    if (!el) return;
    el.textContent = filterEnabled
        ? `🟢 Low-pass ON  (cutoff ${freq} Hz)`
        : '⚪ Low-pass OFF';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FRUSTUM / STEREO CAMERA
// ═══════════════════════════════════════════════════════════════════════════════
function makeFrustum(left, right, bottom, top, near, far) {
    const dx = right-left, dy = top-bottom, dz = far-near;
    return [
        2*near/dx, 0, 0, 0,
        0, 2*near/dy, 0, 0,
        (right+left)/dx, (top+bottom)/dy, -(far+near)/dz, -1,
        0, 0, -2*far*near/dz, 0
    ];
}

function StereoCamera(Convergence, EyeSeparation, AspectRatio, FOVdeg, Near, Far) {
    this.mConvergence = Convergence; this.mEyeSep = EyeSeparation;
    this.mAspect = AspectRatio; this.mFOV = FOVdeg * Math.PI / 180;
    this.mNear = Near; this.mFar = Far;

    this.ApplyLeftFrustum = function () {
        const top = this.mNear * Math.tan(this.mFOV/2);
        const a = this.mAspect * Math.tan(this.mFOV/2) * this.mConvergence;
        const b = a - this.mEyeSep/2, c = a + this.mEyeSep/2;
        return { proj: makeFrustum(-b*this.mNear/this.mConvergence,
                                    c*this.mNear/this.mConvergence,
                                   -top, top, this.mNear, this.mFar),
                 eyeOffset: +this.mEyeSep/2 };
    };
    this.ApplyRightFrustum = function () {
        const top = this.mNear * Math.tan(this.mFOV/2);
        const a = this.mAspect * Math.tan(this.mFOV/2) * this.mConvergence;
        const b = a - this.mEyeSep/2, c = a + this.mEyeSep/2;
        return { proj: makeFrustum(-c*this.mNear/this.mConvergence,
                                    b*this.mNear/this.mConvergence,
                                   -top, top, this.mNear, this.mFar),
                 eyeOffset: -this.mEyeSep/2 };
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL
// ═══════════════════════════════════════════════════════════════════════════════
function Model(name) {
    this.name          = name;
    this.iVertexBuffer = gl.createBuffer();
    this.count = 0; this.segments = []; this.drawMode = null;

    this.BufferData = function (vertices, segments, mode) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.iVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this.count    = vertices.length / 3;
        this.segments = (segments && segments.length)
                        ? segments : [{ start:0, count:this.count }];
        this.drawMode = mode;
    };

    this.Draw = function (program) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.iVertexBuffer);
        const attr = gl.getAttribLocation(program.prog, 'vertex');
        gl.vertexAttribPointer(attr, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(attr);
        if (this.drawMode === gl.TRIANGLES) {
            gl.drawArrays(gl.TRIANGLES, 0, this.count);
        } else {
            for (const seg of this.segments)
                if (seg.count >= 2) gl.drawArrays(gl.LINE_STRIP, seg.start, seg.count);
        }
    };
}

function ShaderProgram(name, program) {
    this.name = name; this.prog = program;
    this.Use = function () { gl.useProgram(this.prog); };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEOVIOUS SURFACE
// ═══════════════════════════════════════════════════════════════════════════════
function solveThird(a, b, sign) {
    const ca = Math.cos(a), cb = Math.cos(b);
    const denom = 3.0 + 4.0 * ca * cb;
    if (Math.abs(denom) < 1e-6) return null;
    const arg = -3.0 * (ca + cb) / denom;
    if (arg < -1.0 || arg > 1.0) return null;
    return sign > 0 ? Math.acos(arg) : -Math.acos(arg);
}

function mapXYZ(pt, p1, p2, t) {
    if (pt==='Z') return [p1,p2,t];
    if (pt==='X') return [t,p1,p2];
    if (pt==='Y') return [p1,t,p2];
    return [0,0,0];
}

function CreateSurfaceData() {
    const U = { vertices:[], segments:[] };
    const V = { vertices:[], segments:[] };
    const signs = DRAW_BOTH_SIGNS ? [+1,-1] : [+1];

    function appendPoly(target, pts) {
        const start = target.vertices.length/3;
        for (const p of pts) target.vertices.push(p[0]*SCALE, p[1]*SCALE, p[2]*SCALE);
        target.segments.push({ start, count:pts.length });
    }
    function buildFamily(target, pt, sign, isU) {
        for (let li=0; li<LINES; li++) {
            const cVal = P_MIN + (P_MAX-P_MIN)*li/(LINES-1);
            let cur = [];
            for (let si=0; si<SAMPLES; si++) {
                const sVal = P_MIN + (P_MAX-P_MIN)*si/(SAMPLES-1);
                const p1 = isU?cVal:sVal, p2 = isU?sVal:cVal;
                const third = solveThird(p1, p2, sign);
                if (third===null) { if(cur.length>=2) appendPoly(target,cur); cur=[]; }
                else cur.push(mapXYZ(pt, p1, p2, third));
            }
            if (cur.length>=2) appendPoly(target, cur);
        }
    }
    for (const p of ['Z','X','Y'])
        for (const s of signs) { buildFamily(U,p,s,true); buildFamily(V,p,s,false); }
    return { U, V };
}

function CreateSurfaceMesh() {
    const verts=[], N=MESH_SIZE, signs=DRAW_BOTH_SIGNS?[+1,-1]:[+1];
    for (const pt of ['Z','X','Y']) {
        for (const sgn of signs) {
            const grid=[];
            for (let i=0;i<N;i++) {
                grid[i]=[];
                const p1 = P_MIN+(P_MAX-P_MIN)*i/(N-1);
                for (let j=0;j<N;j++) {
                    const p2 = P_MIN+(P_MAX-P_MIN)*j/(N-1);
                    const t  = solveThird(p1, p2, sgn);
                    if (t===null) { grid[i][j]=null; continue; }
                    const xyz = mapXYZ(pt, p1, p2, t);
                    grid[i][j] = [xyz[0]*SCALE, xyz[1]*SCALE, xyz[2]*SCALE];
                }
            }
            for (let i=0;i<N-1;i++) for (let j=0;j<N-1;j++) {
                const v00=grid[i][j], v10=grid[i+1][j],
                      v01=grid[i][j+1], v11=grid[i+1][j+1];
                if (v00&&v10&&v01) verts.push(...v00,...v10,...v01);
                if (v10&&v11&&v01) verts.push(...v10,...v11,...v01);
            }
        }
    }
    return verts;
}

// ─── Unit sphere mesh ─────────────────────────────────────────────────────────
function CreateSphereMesh(stacks, slices) {
    const verts = [];
    for (let i = 0; i < stacks; i++) {
        const phi0 = Math.PI * i       / stacks - Math.PI/2;
        const phi1 = Math.PI * (i + 1) / stacks - Math.PI/2;
        for (let j = 0; j < slices; j++) {
            const th0 = 2*Math.PI * j       / slices;
            const th1 = 2*Math.PI * (j + 1) / slices;
            const p = (ph, th) => [Math.cos(ph)*Math.cos(th),
                                   Math.sin(ph),
                                   Math.cos(ph)*Math.sin(th)];
            const v00=p(phi0,th0), v10=p(phi1,th0),
                  v01=p(phi0,th1), v11=p(phi1,th1);
            verts.push(...v00,...v10,...v11, ...v00,...v11,...v01);
        }
    }
    return verts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════════
function renderScene(proj, eyeOffset) {
    const baseMV = spaceball.getViewMatrix();
    const mv0    = m4.multiply(m4.axisRotation([0.707, 0.707, 0], 0.7), baseMV);
    const mv1    = m4.multiply(m4.translation(0, 0, -10), mv0);
    const eyeMV  = m4.multiply(m4.translation(eyeOffset, 0, 0), mv1);
    const mvp    = m4.multiply(proj, eyeMV);

    // ── Surface ───────────────────────────────────────────────────────────────
    gl.useProgram(shProgram.prog);
    gl.uniformMatrix4fv(
        gl.getUniformLocation(shProgram.prog, 'ModelViewProjectionMatrix'),
        false, mvp);

    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.uniform4fv(gl.getUniformLocation(shProgram.prog, 'color'),
                  [0.08, 0.08, 0.08, 1.0]);
    surfaceFill.Draw(shProgram);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.uniform4fv(gl.getUniformLocation(shProgram.prog, 'color'), [1.0, 1.0, 0.0, 1.0]);
    surfaceU.Draw(shProgram);
    gl.uniform4fv(gl.getUniformLocation(shProgram.prog, 'color'), [0.0, 1.0, 1.0, 1.0]);
    surfaceV.Draw(shProgram);

    // ── Sound source sphere ───────────────────────────────────────────────────
    gl.useProgram(sphereProgram.prog);
    gl.uniformMatrix4fv(
        gl.getUniformLocation(sphereProgram.prog, 'ModelViewProjectionMatrix'),
        false, mvp);
    gl.uniform3f(gl.getUniformLocation(sphereProgram.prog, 'uSpherePos'),
                 sourcePos.x, sourcePos.y, sourcePos.z);
    gl.uniform1f(gl.getUniformLocation(sphereProgram.prog, 'uSphereRadius'), 0.1);

    const playing = audioCtx && audioCtx.state === 'running';
    const glow = playing ? 0.5 + 0.5 * Math.sin(Date.now() / 300) : 0.2;
    gl.uniform4f(gl.getUniformLocation(sphereProgram.prog, 'uSphereColor'),
                 1.0, glow, 0.0, 1.0);
    sphereModel.Draw(sphereProgram);
}

function draw() {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cam = new StereoCamera(convergence, eyeSeparation, 1.0, fov, nearClipping, FAR_CLIPPING);
    const L = cam.ApplyLeftFrustum();
    const R = cam.ApplyRightFrustum();

    gl.colorMask(true,  false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    renderScene(L.proj, L.eyeOffset);

    gl.colorMask(false, true, true, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    renderScene(R.proj, R.eyeOffset);

    gl.colorMask(true, true, true, true);
}

function renderLoop() { draw(); requestAnimationFrame(renderLoop); }

// ═══════════════════════════════════════════════════════════════════════════════
// SHADER COMPILATION
// ═══════════════════════════════════════════════════════════════════════════════
function createProgram(gl, vSrc, fSrc) {
    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(s));
        return s;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER,   vSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
    return prog;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
function initGL() {
    shProgram = new ShaderProgram('Surface',
        createProgram(gl, vertexShaderSource, fragmentShaderSource));
    sphereProgram = new ShaderProgram('Sphere',
        createProgram(gl, sphereVertexShaderSource, sphereFragmentShaderSource));

    const wfData = CreateSurfaceData();
    surfaceU    = new Model('SurfaceU');
    surfaceU.BufferData(wfData.U.vertices, wfData.U.segments, gl.LINE_STRIP);
    surfaceV    = new Model('SurfaceV');
    surfaceV.BufferData(wfData.V.vertices, wfData.V.segments, gl.LINE_STRIP);
    surfaceFill = new Model('SurfaceFill');
    surfaceFill.BufferData(CreateSurfaceMesh(), [], gl.TRIANGLES);
    sphereModel = new Model('Sphere');
    sphereModel.BufferData(CreateSphereMesh(16, 16), [], gl.TRIANGLES);

    gl.enable(gl.DEPTH_TEST);
}

function init() {
    let canvas;
    try {
        canvas = document.getElementById('webglcanvas');
        gl     = canvas.getContext('webgl');
        if (!gl) throw 'Browser does not support WebGL';
    } catch (e) {
        document.getElementById('canvas-holder').innerHTML =
            `<p style="color:#ff4444">WebGL unavailable: ${e}</p>`;
        return;
    }
    try { initGL(); } catch (e) {
        document.getElementById('canvas-holder').innerHTML =
            `<p style="color:#ff4444">GL init error: ${e}</p>`;
        return;
    }

    // ── Stereo sliders ─────────────────────────────────────────────────────────
    function bindSlider(id, valId, setter, fmt) {
        document.getElementById(id).addEventListener('input', function () {
            setter(parseFloat(this.value));
            document.getElementById(valId).textContent = fmt(parseFloat(this.value));
        });
    }
    bindSlider('eyeSep',      'eyeSepVal',     v => eyeSeparation=v, v=>v.toFixed(2));
    bindSlider('convergence', 'convergenceVal',v => convergence=v,   v=>v.toFixed(1));
    bindSlider('fov',         'fovVal',        v => fov=v,           v=>v.toFixed(0)+'°');
    bindSlider('nearClip',    'nearClipVal',   v => nearClipping=v,  v=>v.toFixed(1));

    // ── Sensor ─────────────────────────────────────────────────────────────────
    document.getElementById('btnConnect').addEventListener('click', () => {
        const ip   = document.getElementById('sensorIP').value.trim();
        const port = parseInt(document.getElementById('sensorPort').value) || 8765;
        if (!ip) { setSensorStatus('error', 'Enter bridge IP first'); return; }
        connectSensor(ip, port);
    });
    document.getElementById('btnDisconnect').addEventListener('click', disconnectSensor);

    // ── Audio ──────────────────────────────────────────────────────────────────
    document.getElementById('btnLoadAudio').addEventListener('click', () => {
        const file = document.getElementById('audioFile').files[0];
        if (!file) { setAudioStatus('❌ Choose an MP3/OGG file first'); return; }
        loadAudioFile(file);
    });
    document.getElementById('btnPlay').onclick = playAudio;

    // ── Filter ─────────────────────────────────────────────────────────────────
    document.getElementById('chkFilter').addEventListener('change', function () {
        toggleFilter(this.checked);
        updateFilterStatus();
    });
    document.getElementById('filterFreq').addEventListener('input', function () {
        const val = parseFloat(this.value);
        document.getElementById('filterFreqVal').textContent = val + ' Hz';
        if (filterNode) filterNode.frequency.value = val;
        updateFilterStatus();
    });

    // ── TrackballRotator ───────────────────────────────────────────────────────
    spaceball = new TrackballRotator(canvas, draw, 0);

    setSensorStatus('idle', 'Not connected — rotate view with mouse');
    renderLoop();
}