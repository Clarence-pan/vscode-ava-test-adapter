const TapParser = require('tap-parser');
const { spawn } = require('child_process');

const p = new TapParser({ passes: true }, (results) => {
  console.dir(results);
});

const proc = spawn('npx ava', ['--tap'], {
  cwd: '/tmp/xxx',
  env: undefined,
  stdio: 'pipe',
  shell: true,
});

proc.stdout.pipe(p);
