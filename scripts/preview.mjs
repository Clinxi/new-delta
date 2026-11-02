// Isolated demo data; never shares participants or credentials with a real event.
import { createApp } from '../server.js';
const port = Number(process.env.PREVIEW_PORT || 3188);
const instance = createApp({dataDir:'.preview-data',adminPassword:'preview-ceremony-only',port,publicUrl:`http://localhost:${port}`});
const server = instance.app.listen(port,'127.0.0.1',(error)=>{
  if(error)return;
  console.log(`演示预览：http://localhost:${port}/admin.html\n仅演示口令：preview-ceremony-only\n数据位于 .preview-data，与正式 data 隔离。`);
});
server.on('error',error=>{console.error(error.message);instance.close();process.exitCode=1;});
const shutdown=()=>{instance.close();server.close(()=>process.exit(0));};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
