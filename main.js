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
const MESH_SIZE      = 45;   // NxN grid per patch/sign for filled triangles
const DRAW_BOTH_SIGNS = true;

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

    // Returns { proj: Float32Array[16], eyeOffset: number }
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
            eyeOffset: +this.mEyeSep / 2   // world moves RIGHT → camera is LEFT
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
            eyeOffset: -this.mEyeSep / 2   // world moves LEFT → camera is RIGHT
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
    this.name                    = name;
    this.prog                    = program;
    this.iAttribVertex           = -1;
    this.iColor                  = -1;
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
            // Build NxN grid of xyz (or null where surface is undefined)
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

            // Emit triangles for each 2×2 cell (skip degenerate ones)
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
    // Placeholder 1×1 black texture (used even if camera is unavailable)
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

// Draw webcam as full-screen background (zero parallax — no eye offset)
function drawWebcam() {
    if (!webcamProgram || !webcamQuadBuf || !videoTexture) return;

    gl.useProgram(webcamProgram.prog);

    // Render behind everything, no depth writes
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

    // Restore state and switch back to surface shader
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

    // ModelView: trackball → initial rotation → push back → eye offset
    let mv = spaceball.getViewMatrix();
    mv = m4.multiply(m4.axisRotation([0.707, 0.707, 0], 0.7), mv);
    mv = m4.multiply(m4.translation(0, 0, -10), mv);
    mv = m4.multiply(m4.translation(eyeOffset, 0, 0), mv);  // stereo shift

    const mvp = m4.multiply(proj, mv);
    gl.uniformMatrix4fv(shProgram.iModelViewProjectionMatrix, false, mvp);

    // ── 1. Filled polygons (slightly pushed back to avoid Z-fighting) ──────────
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.uniform4fv(shProgram.iColor, [0.08, 0.08, 0.08, 1.0]);
    surfaceFill.Draw();
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ── 2. Wireframe on top ───────────────────────────────────────────────────
    gl.uniform4fv(shProgram.iColor, [1.0, 1.0, 0.0, 1.0]);   // yellow — U family
    surfaceU.Draw();
    gl.uniform4fv(shProgram.iColor, [0.0, 1.0, 1.0, 1.0]);   // cyan   — V family
    surfaceV.Draw();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DRAW
// ═══════════════════════════════════════════════════════════════════════════════
// Continuous render loop — needed so webcam stream updates every frame
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

    // ── LEFT EYE  →  red channel ──────────────────────────────────────────────
    gl.colorMask(true, false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawWebcam();                                   // zero-parallax background
    renderScene(leftEye.proj, leftEye.eyeOffset);

    // ── RIGHT EYE  →  cyan channel (green + blue) ─────────────────────────────
    gl.colorMask(false, true, true, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawWebcam();                                   // zero-parallax background
    renderScene(rightEye.proj, rightEye.eyeOffset);

    // ── Restore full color mask ───────────────────────────────────────────────
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
    // ── Surface shader ────────────────────────────────────────────────────────
    const surfProg = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    shProgram = new ShaderProgram('Surface', surfProg);
    shProgram.Use();
    shProgram.iAttribVertex           = gl.getAttribLocation (surfProg, 'vertex');
    shProgram.iModelViewProjectionMatrix = gl.getUniformLocation(surfProg, 'ModelViewProjectionMatrix');
    shProgram.iColor                  = gl.getUniformLocation(surfProg, 'color');

    // ── Webcam shader ─────────────────────────────────────────────────────────
    const camProg = createProgram(gl, webcamVertexShaderSource, webcamFragmentShaderSource);
    webcamProgram = new ShaderProgram('Webcam', camProg);

    // Full-screen quad: [x, y, u, v]  ×4
    webcamQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, webcamQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,   0, 0,   // bottom-left
         1, -1,   1, 0,   // bottom-right
        -1,  1,   0, 1,   // top-left
         1,  1,   1, 1    // top-right
    ]), gl.STATIC_DRAW);

    // ── Wireframe ─────────────────────────────────────────────────────────────
    const wfData = CreateSurfaceData();

    surfaceU = new Model('SurfaceU');
    surfaceU.BufferData(wfData.U.vertices, wfData.U.segments, gl.LINE_STRIP);

    surfaceV = new Model('SurfaceV');
    surfaceV.BufferData(wfData.V.vertices, wfData.V.segments, gl.LINE_STRIP);

    // ── Filled mesh ───────────────────────────────────────────────────────────
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

    // ── UI event listeners ────────────────────────────────────────────────────
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

    // ── TrackballRotator ──────────────────────────────────────────────────────
    spaceball = new TrackballRotator(canvas, draw, 0);

    // ── Webcam (async) ────────────────────────────────────────────────────────
    initWebcam();

    // Start continuous render loop (keeps webcam stream alive every frame)
    renderLoop();
}
