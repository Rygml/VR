'use strict';

// ─── Globals ──────────────────────────────────────────────────────────────────
let gl;
let surfaceU, surfaceV, surfaceFill;
let shProgram;
let webcamProgram;
let spaceball;

let video         = null;
let videoTexture  = null;
let webcamQuadBuf = null;

// ─── UI parameters (defaults) ────────────────────────────────────────────────
let eyeSeparation = 0.5;
let convergence   = 10.0;
let fov           = 45.0;
let nearClipping  = 8.0;
const FAR_CLIPPING = 20.0;

// ─── Surface constants ────────────────────────────────────────────────────────
const SCALE          = 0.35;
const P_MIN          = -Math.PI / 2;
const P_MAX          =  Math.PI / 2;
const LINES          = 30;
const SAMPLES        = 60;
const MESH_SIZE      = 45;
const DRAW_BOTH_SIGNS = true;

// ═══════════════════════════════════════════════════════════════════════════════
// PA2 — SENSOR (Variant 16: software orientation sensor → ZXY rotation matrix)
// ═══════════════════════════════════════════════════════════════════════════════

let sensorRotation  = null;   // 4×4 matrix, set in init() to identity
let sensorConnected = false;
let wsConnection    = null;

/**
 * Build a 4×4 rotation matrix from Euler angles using ZXY accumulation order.
 * This is the standard Android TYPE_ORIENTATION convention used in Variant 16.
 *
 * R = Rz(azimuth) · Rx(pitch) · Ry(roll)
 *
 * @param {number} azimuth  – rotation around Z axis (yaw),   radians
 * @param {number} pitch    – rotation around X axis (tilt),  radians
 * @param {number} roll     – rotation around Y axis (roll),  radians
 * @returns {number[]} 16-element column-major matrix
 */
function buildOrientationMatrix(azimuth, pitch, roll) {
    // ── Individual axis rotation matrices ──────────────────────────────────────
    // m4.axisRotation([axis], angle) returns a column-major 4×4 matrix
    const Rz = m4.axisRotation([0, 0, 1], azimuth);   // Rotate around Z
    const Rx = m4.axisRotation([1, 0, 0], pitch);     // Rotate around X
    const Ry = m4.axisRotation([0, 1, 0], roll);      // Rotate around Y

    // ── Accumulated ZXY: R = Rz · Rx · Ry ─────────────────────────────────────
    return m4.multiply(m4.multiply(Rz, Rx), Ry);
}

/**
 * Connect to the Node.js WebSocket bridge running on the local network.
 * @param {string} ip   – IP address of the PC running bridge/server.js
 * @param {number} port – port (default 8765)
 */
function connectSensor(ip, port) {
    if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
    }

    const url = `ws://${ip}:${port}/`;
    setSensorStatus('connecting', `Connecting to ${url}…`);

    try {
        wsConnection = new WebSocket(url);
    } catch (e) {
        setSensorStatus('error', `Invalid address: ${e.message}`);
        return;
    }

    wsConnection.onopen = () => {
        sensorConnected = true;
        setSensorStatus('ok', `Connected → ${url}`);
        console.log('[sensor] WebSocket connected');
    };

    wsConnection.onmessage = (evt) => {
        try {
            const d = JSON.parse(evt.data);
            // d = { azimuth: number, pitch: number, roll: number }  (radians)
            const az = d.azimuth ?? 0;
            const pt = d.pitch   ?? 0;
            const rl = d.roll    ?? 0;
            sensorRotation = buildOrientationMatrix(az, pt, rl);
        } catch (e) {
            console.warn('[sensor] bad message:', e.message);
        }
    };

    wsConnection.onerror = () => {
        setSensorStatus('error', 'Connection error. Is the bridge running?');
    };

    wsConnection.onclose = () => {
        sensorConnected = false;
        wsConnection    = null;
        setSensorStatus('idle', 'Disconnected — trackball mode active');
    };
}

function disconnectSensor() {
    if (wsConnection) wsConnection.close();
    sensorConnected = false;
    setSensorStatus('idle', 'Disconnected — trackball mode active');
}

function setSensorStatus(state, msg) {
    const el = document.getElementById('sensorStatus');
    if (!el) return;
    const icons = { ok: '📡', connecting: '⏳', error: '❌', idle: '🔌' };
    const colors = { ok: '#00FF99', connecting: '#FFD700', error: '#FF4444', idle: '#888' };
    el.textContent = (icons[state] || '') + ' ' + msg;
    el.style.color = colors[state] || '#888';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FRUSTUM MATRIX  (column-major, WebGL convention)
// ═══════════════════════════════════════════════════════════════════════════════
function makeFrustum(left, right, bottom, top, near, far) {
    const dx = right - left;
    const dy = top   - bottom;
    const dz = far   - near;
    return [
        2 * near / dx,            0,                         0,                        0,
        0,                        2 * near / dy,             0,                        0,
        (right + left) / dx,      (top + bottom) / dy,      -(far + near) / dz,       -1,
        0,                        0,                        -2 * far * near / dz,       0
    ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEREO CAMERA
// ═══════════════════════════════════════════════════════════════════════════════
function StereoCamera(Convergence, EyeSeparation, AspectRatio, FOVdeg,
                      NearClippingDistance, FarClippingDistance) {
    this.mConvergence  = Convergence;
    this.mEyeSep       = EyeSeparation;
    this.mAspect       = AspectRatio;
    this.mFOV          = FOVdeg * Math.PI / 180.0;
    this.mNear         = NearClippingDistance;
    this.mFar          = FarClippingDistance;

    this.ApplyLeftFrustum = function () {
        const top    =  this.mNear * Math.tan(this.mFOV / 2);
        const bottom = -top;
        const a      =  this.mAspect * Math.tan(this.mFOV / 2) * this.mConvergence;
        const b      =  a - this.mEyeSep / 2;
        const c      =  a + this.mEyeSep / 2;
        const left   = -b * this.mNear / this.mConvergence;
        const right  =  c * this.mNear / this.mConvergence;
        return {
            proj:      makeFrustum(left, right, bottom, top, this.mNear, this.mFar),
            eyeOffset: +this.mEyeSep / 2
        };
    };

    this.ApplyRightFrustum = function () {
        const top    =  this.mNear * Math.tan(this.mFOV / 2);
        const bottom = -top;
        const a      =  this.mAspect * Math.tan(this.mFOV / 2) * this.mConvergence;
        const b      =  a - this.mEyeSep / 2;
        const c      =  a + this.mEyeSep / 2;
        const left   = -c * this.mNear / this.mConvergence;
        const right  =  b * this.mNear / this.mConvergence;
        return {
            proj:      makeFrustum(left, right, bottom, top, this.mNear, this.mFar),
            eyeOffset: -this.mEyeSep / 2
        };
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL
// ═══════════════════════════════════════════════════════════════════════════════
function Model(name) {
    this.name          = name;
    this.iVertexBuffer = gl.createBuffer();
    this.count         = 0;
    this.segments      = [];
    this.drawMode      = null;

    this.BufferData = function (vertices, segments, mode) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.iVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this.count    = vertices.length / 3;
        this.segments = (segments && segments.length)
                        ? segments
                        : [{ start: 0, count: this.count }];
        this.drawMode = mode;
    };

    this.Draw = function () {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.iVertexBuffer);
        gl.vertexAttribPointer(shProgram.iAttribVertex, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(shProgram.iAttribVertex);

        if (this.drawMode === gl.TRIANGLES) {
            gl.drawArrays(gl.TRIANGLES, 0, this.count);
        } else {
            for (const seg of this.segments) {
                if (seg.count >= 2) gl.drawArrays(gl.LINE_STRIP, seg.start, seg.count);
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHADER PROGRAM WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════
function ShaderProgram(name, program) {
    this.name                       = name;
    this.prog                       = program;
    this.iAttribVertex              = -1;
    this.iColor                     = -1;
    this.iModelViewProjectionMatrix = -1;
    this.Use = function () { gl.useProgram(this.prog); };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEOVIOUS SURFACE MATH
// ═══════════════════════════════════════════════════════════════════════════════
function solveThird(a, b, sign) {
    const ca    = Math.cos(a), cb = Math.cos(b);
    const denom = 3.0 + 4.0 * ca * cb;
    if (Math.abs(denom) < 1e-6) return null;
    const arg = -3.0 * (ca + cb) / denom;
    if (arg < -1.0 || arg > 1.0) return null;
    const t = Math.acos(arg);
    return (sign > 0) ? t : -t;
}

function mapXYZ(patchType, p1, p2, third) {
    if (patchType === 'Z') return [p1,    p2,    third];
    if (patchType === 'X') return [third, p1,    p2   ];
    if (patchType === 'Y') return [p1,    third, p2   ];
    return [0, 0, 0];
}

// ─── Wireframe (U and V polyline families) ────────────────────────────────────
function CreateSurfaceData() {
    const U = { vertices: [], segments: [] };
    const V = { vertices: [], segments: [] };

    const signs   = DRAW_BOTH_SIGNS ? [+1, -1] : [+1];
    const patches = ['Z', 'X', 'Y'];

    function appendPolyline(target, pts) {
        const start = target.vertices.length / 3;
        for (const p of pts) target.vertices.push(p[0]*SCALE, p[1]*SCALE, p[2]*SCALE);
        target.segments.push({ start, count: pts.length });
    }

    function buildFamily(target, patchType, sign, isU) {
        for (let li = 0; li < LINES; li++) {
            const t    = (LINES === 1) ? 0 : li / (LINES - 1);
            const cVal = P_MIN + (P_MAX - P_MIN) * t;
            let current = [];

            for (let si = 0; si < SAMPLES; si++) {
                const ts   = (SAMPLES === 1) ? 0 : si / (SAMPLES - 1);
                const sVal = P_MIN + (P_MAX - P_MIN) * ts;
                const p1   = isU ? cVal : sVal;
                const p2   = isU ? sVal : cVal;
                const third = solveThird(p1, p2, sign);
                if (third === null) {
                    if (current.length >= 2) appendPolyline(target, current);
                    current = [];
                    continue;
                }
                current.push(mapXYZ(patchType, p1, p2, third));
            }
            if (current.length >= 2) appendPolyline(target, current);
        }
    }

    for (const p of patches) {
        for (const s of signs) {
            buildFamily(U, p, s, true);
            buildFamily(V, p, s, false);
        }
    }
    return { U, V };
}

// ─── Filled triangle mesh ─────────────────────────────────────────────────────
function CreateSurfaceMesh() {
    const verts   = [];
    const N       = MESH_SIZE;

    const signs   = DRAW_BOTH_SIGNS ? [+1, -1] : [+1];
    const patches = ['Z', 'X', 'Y'];

    for (const patchType of patches) {
        for (const sgn of signs) {
            const grid = [];
            for (let i = 0; i < N; i++) {
                grid[i] = [];
                const p1 = P_MIN + (P_MAX - P_MIN) * i / (N - 1);
                for (let j = 0; j < N; j++) {
                    const p2    = P_MIN + (P_MAX - P_MIN) * j / (N - 1);
                    const third = solveThird(p1, p2, sgn);
                    if (third === null) {
                        grid[i][j] = null;
                    } else {
                        const xyz  = mapXYZ(patchType, p1, p2, third);
                        grid[i][j] = [xyz[0]*SCALE, xyz[1]*SCALE, xyz[2]*SCALE];
                    }
                }
            }

            for (let i = 0; i < N - 1; i++) {
                for (let j = 0; j < N - 1; j++) {
                    const v00 = grid[i  ][j  ];
                    const v10 = grid[i+1][j  ];
                    const v01 = grid[i  ][j+1];
                    const v11 = grid[i+1][j+1];

                    if (v00 && v10 && v01) verts.push(...v00, ...v10, ...v01);
                    if (v10 && v11 && v01) verts.push(...v10, ...v11, ...v01);
                }
            }
        }
    }
    return verts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBCAM
// ═══════════════════════════════════════════════════════════════════════════════
async function initWebcam() {
    videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video             = document.createElement('video');
        video.srcObject   = stream;
        video.autoplay    = true;
        video.playsInline = true;
        video.muted       = true;
        await video.play();

        document.getElementById('camStatus').textContent = '🎥 Camera: active';
        document.getElementById('camStatus').style.color = '#00FF99';
    } catch (e) {
        console.warn('Webcam unavailable:', e);
        document.getElementById('camStatus').textContent = '🎥 Camera: unavailable';
    }
}

function updateVideoTexture() {
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function drawWebcam() {
    if (!webcamProgram || !webcamQuadBuf || !videoTexture) return;

    gl.useProgram(webcamProgram.prog);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.bindBuffer(gl.ARRAY_BUFFER, webcamQuadBuf);

    const aPos = gl.getAttribLocation(webcamProgram.prog, 'a_position');
    const aTex = gl.getAttribLocation(webcamProgram.prog, 'a_texcoord');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(gl.getUniformLocation(webcamProgram.prog, 'u_texture'), 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aTex);

    shProgram.Use();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENE RENDER (one eye pass)
// ═══════════════════════════════════════════════════════════════════════════════
function renderScene(proj, eyeOffset) {
    shProgram.Use();

    let mv;

    if (sensorConnected && sensorRotation) {
        // ── PA2: sensor drives rotation (ZXY orientation matrix) ───────────────
        mv = sensorRotation;
    } else {
        // ── PA1 fallback: trackball mouse control ──────────────────────────────
        mv = spaceball.getViewMatrix();
        mv = m4.multiply(m4.axisRotation([0.707, 0.707, 0], 0.7), mv);
    }

    // Common: push scene back and apply stereo eye offset
    mv = m4.multiply(m4.translation(0, 0, -10), mv);
    mv = m4.multiply(m4.translation(eyeOffset, 0, 0), mv);

    const mvp = m4.multiply(proj, mv);
    gl.uniformMatrix4fv(shProgram.iModelViewProjectionMatrix, false, mvp);

    // ── 1. Filled polygons ─────────────────────────────────────────────────────
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.uniform4fv(shProgram.iColor, [0.08, 0.08, 0.08, 1.0]);
    surfaceFill.Draw();
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ── 2. Wireframe on top ────────────────────────────────────────────────────
    gl.uniform4fv(shProgram.iColor, [1.0, 1.0, 0.0, 1.0]);   // yellow — U family
    surfaceU.Draw();
    gl.uniform4fv(shProgram.iColor, [0.0, 1.0, 1.0, 1.0]);   // cyan   — V family
    surfaceV.Draw();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DRAW
// ═══════════════════════════════════════════════════════════════════════════════
function renderLoop() {
    draw();
    requestAnimationFrame(renderLoop);
}

function draw() {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    updateVideoTexture();

    const cam = new StereoCamera(
        convergence, eyeSeparation, 1.0, fov, nearClipping, FAR_CLIPPING
    );
    const leftEye  = cam.ApplyLeftFrustum();
    const rightEye = cam.ApplyRightFrustum();

    // ── LEFT EYE → red channel ─────────────────────────────────────────────────
    gl.colorMask(true, false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawWebcam();
    renderScene(leftEye.proj, leftEye.eyeOffset);

    // ── RIGHT EYE → cyan channel ───────────────────────────────────────────────
    gl.colorMask(false, true, true, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawWebcam();
    renderScene(rightEye.proj, rightEye.eyeOffset);

    gl.colorMask(true, true, true, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHADER COMPILATION
// ═══════════════════════════════════════════════════════════════════════════════
function createProgram(gl, vSrc, fSrc) {
    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
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
// INIT GL
// ═══════════════════════════════════════════════════════════════════════════════
function initGL() {
    const surfProg = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    shProgram = new ShaderProgram('Surface', surfProg);
    shProgram.Use();
    shProgram.iAttribVertex              = gl.getAttribLocation (surfProg, 'vertex');
    shProgram.iModelViewProjectionMatrix = gl.getUniformLocation(surfProg, 'ModelViewProjectionMatrix');
    shProgram.iColor                     = gl.getUniformLocation(surfProg, 'color');

    const camProg = createProgram(gl, webcamVertexShaderSource, webcamFragmentShaderSource);
    webcamProgram = new ShaderProgram('Webcam', camProg);

    webcamQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, webcamQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,   0, 0,   // bottom-left
         1, -1,   1, 0,   // bottom-right
        -1,  1,   0, 1,   // top-left
         1,  1,   1, 1    // top-right
    ]), gl.STATIC_DRAW);
    
    const wfData = CreateSurfaceData();

    surfaceU = new Model('SurfaceU');
    surfaceU.BufferData(wfData.U.vertices, wfData.U.segments, gl.LINE_STRIP);

    surfaceV = new Model('SurfaceV');
    surfaceV.BufferData(wfData.V.vertices, wfData.V.segments, gl.LINE_STRIP);

    surfaceFill = new Model('SurfaceFill');
    surfaceFill.BufferData(CreateSurfaceMesh(), [], gl.TRIANGLES);

    gl.enable(gl.DEPTH_TEST);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════
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

    try {
        initGL();
    } catch (e) {
        document.getElementById('canvas-holder').innerHTML =
            `<p style="color:#ff4444">GL init error: ${e}</p>`;
        return;
    }

    // Initialise sensor rotation to identity (m4 is loaded by now)
    sensorRotation = m4.identity();

    // ── UI: stereo sliders ─────────────────────────────────────────────────────
    function bindSlider(id, valId, setter, fmt) {
        const el = document.getElementById(id);
        el.addEventListener('input', function () {
            setter(parseFloat(this.value));
            document.getElementById(valId).textContent = fmt(parseFloat(this.value));
            draw();
        });
    }

    bindSlider('eyeSep',      'eyeSepVal',     v => eyeSeparation = v, v => v.toFixed(2));
    bindSlider('convergence', 'convergenceVal',v => convergence   = v, v => v.toFixed(1));
    bindSlider('fov',         'fovVal',        v => fov           = v, v => v.toFixed(0) + '°');
    bindSlider('nearClip',    'nearClipVal',   v => nearClipping  = v, v => v.toFixed(1));

    // ── UI: sensor connect / disconnect buttons ────────────────────────────────
    document.getElementById('btnConnect').addEventListener('click', () => {
        const ip   = document.getElementById('sensorIP').value.trim();
        const port = parseInt(document.getElementById('sensorPort').value.trim(), 10) || 8765;
        if (!ip) { setSensorStatus('error', 'Enter the bridge IP address first'); return; }
        connectSensor(ip, port);
    });

    document.getElementById('btnDisconnect').addEventListener('click', () => {
        disconnectSensor();
    });

    // ── TrackballRotator ───────────────────────────────────────────────────────
    spaceball = new TrackballRotator(canvas, draw, 0);

    // ── Webcam (async) ─────────────────────────────────────────────────────────
    initWebcam();

    setSensorStatus('idle', 'Not connected — trackball mode active');

    renderLoop();
}
