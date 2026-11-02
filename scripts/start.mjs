import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 9)) {
  console.error('需要 Node.js 22.9 或更高版本，建议安装 Node.js 24。'); process.exit(1);
}
const configPath = resolve(root, '.env');
if (!existsSync(configPath)) {
  const password = randomBytes(18).toString('base64url');
  writeFileSync(configPath, `# 本机配置。主持口令请妥善保存，不要把此文件发给嘉宾。\nPORT=3188\nHOST=0.0.0.0\nADMIN_PASSWORD=${password}\nPUBLIC_URL=\nDATA_DIR=./data\nMAX_PARTICIPANTS=1000\nJOIN_RATE_LIMIT=2000\nTRUST_PROXY=0\n`, { mode:0o600, flag:'wx' });
  console.log(`已创建本机配置 .env\n首次主持口令：${password}\n`);
}
const config = parseEnv(readFileSync(configPath, 'utf8'));
if (!existsSync(resolve(root,'node_modules/express')) || !existsSync(resolve(root,'node_modules/qrcode')) || !existsSync(resolve(root,'node_modules/image-size'))) {
  console.log('正在安装项目依赖…');
  const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], {cwd:root,stdio:'inherit'});
  if (install.status !== 0) process.exit(install.status || 1);
}
const env = {...process.env,...config};
console.log(`主持口令保存在：${configPath}\n退出服务：在此终端按 Control + C\n`);
const child = spawn(process.execPath, ['server.js'], {cwd:root,stdio:['inherit','inherit','inherit','ipc'],env});
child.once('message',message=>{
  if (message?.type==='ready' && process.platform==='darwin') {
    spawn('open',[`http://localhost:${env.PORT||3000}/admin.html`],{stdio:'ignore'}).unref();
  }
});
process.on('SIGINT',()=>child.kill('SIGINT')); process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code || 0;});
