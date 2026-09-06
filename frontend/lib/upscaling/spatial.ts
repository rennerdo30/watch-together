/** Bicubic interpolation with restrained, neighborhood-clamped sharpening.
 * This is a spatial filter, not FSR or neural reconstruction. */
const vertex = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0., 1.); }
`;
const fragment = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 inputSize;
uniform vec2 outputSize;
uniform float strength;
out vec4 color;
float cubic(float x) {
  x = abs(x);
  if (x <= 1.) return 1.5*x*x*x - 2.5*x*x + 1.;
  if (x < 2.) return -.5*x*x*x + 2.5*x*x - 4.*x + 2.;
  return 0.;
}
vec3 pixel(vec2 p) { return texture(source, (p + .5) / inputSize).rgb; }
void main() {
  vec2 p = gl_FragCoord.xy / outputSize * inputSize - .5;
  vec2 base = floor(p);
  vec2 f = fract(p);
  vec3 sum = vec3(0.);
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    sum += pixel(base + vec2(x,y)) * cubic(float(x)-f.x) * cubic(float(y)-f.y);
  }
  vec3 a = pixel(base), b = pixel(base + vec2(1.,0.));
  vec3 c = pixel(base + vec2(0.,1.)), d = pixel(base + vec2(1.));
  vec3 lo = min(min(a,b),min(c,d)), hi = max(max(a,b),max(c,d));
  vec3 mean = (a+b+c+d)*.25;
  color = vec4(clamp(sum + strength*(sum-mean), lo, hi), 1.);
}
`;

export class SpatialRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private texture: WebGLTexture;
  private disposed = false;
  readonly maxTexture: number;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('GPU enhancement unavailable');
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const program = gl.createProgram();
    if (!program) throw new Error('Could not create spatial renderer');
    this.program = program;
    try {
      for (const [type, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Could not create shader');
        gl.shaderSource(shader, code); gl.compileShader(shader);
        const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        if (compiled) gl.attachShader(program, shader);
        gl.deleteShader(shader);
        if (!compiled) throw new Error('Spatial shader compilation failed');
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Spatial shader linking failed');
      gl.useProgram(program);
      this.buffer = gl.createBuffer()!;
      this.texture = gl.createTexture()!;
      if (!this.buffer || !this.texture) throw new Error('GPU allocation failed');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.uniform1i(gl.getUniformLocation(program, 'source'), 0);
    } catch (error) { gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext(); throw error; }
  }

  async render(video: HTMLVideoElement, width: number, height: number, animation: boolean) {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) throw new Error('GPU connection lost');
    if (Math.max(video.videoWidth, video.videoHeight, width, height) > this.maxTexture) throw new Error('GPU size limit');
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.uniform2f(gl.getUniformLocation(this.program, 'inputSize'), video.videoWidth, video.videoHeight);
    gl.uniform2f(gl.getUniformLocation(this.program, 'outputSize'), width, height);
    gl.uniform1f(gl.getUniformLocation(this.program, 'strength'), animation ? 0.3 : 0.12);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Frame could not be enhanced');
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) throw new Error('GPU synchronization unavailable');
    gl.flush();
    const start = performance.now();
    // Yield rather than gl.finish(), which blocks playback and UI on the CPU.
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = () => {
          if (this.disposed || gl.isContextLost() || performance.now() - start > 1500) { reject(new Error('GPU timed out')); return; }
          const state = gl.clientWaitSync(fence, 0, 0);
          if (state === gl.WAIT_FAILED) reject(new Error('GPU synchronization failed'));
          else if (state === gl.TIMEOUT_EXPIRED) setTimeout(poll, 2);
          else resolve();
        };
        poll();
      });
    } finally { gl.deleteSync(fence); }
  }

  dispose() {
    this.disposed = true;
    this.gl.deleteTexture(this.texture); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
