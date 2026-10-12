import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Qualification-only media endpoint: production serving never imports this fixture. */
export default defineConfig({
 root:fileURLToPath(new URL('../../../',import.meta.url)),
 plugins:[react(),{
  name:'synthetic-retained-image',
  configureServer(server){
   const png=readFileSync(new URL('./synthetic-signal.png',import.meta.url));
   server.middlewares.use((request,response,next)=>{
    const url=new URL(request.url??'/', 'http://fixture.invalid');
    if(!/^\/api\/projects\/fixture\/nodes\/fixture\/workers\/native-\d+-\d+\/image$/.test(url.pathname))return next();
    if(url.searchParams.get('id')!==`sha256:${'a'.repeat(64)}`){response.statusCode=404;response.end();return;}
    response.setHeader('Content-Type','image/png');response.setHeader('Content-Length',png.length);
    response.end(png);
   });
  },
 }],
});
