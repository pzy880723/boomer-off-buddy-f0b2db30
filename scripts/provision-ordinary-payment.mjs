// Provisions server-only bindings over SSH stdin. No secrets in arguments, logs or git.
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';

const [zipPath, publicKeyPath, apiKeyPath, sshKeyPath] = process.argv.slice(2);
if (![zipPath, publicKeyPath, apiKeyPath, sshKeyPath].every(Boolean)) throw new Error('Four local file paths required');
const privatePem = execFileSync('unzip', ['-p', zipPath, 'apiclient_key.pem']);
const cert = new X509Certificate(execFileSync('unzip', ['-p', zipPath, 'apiclient_cert.pem']));
const publicPem = readFileSync(publicKeyPath);
const apiKey = readFileSync(apiKeyPath, 'utf8').replace(/\r?\n$/, '');
if (!cert.checkPrivateKey(createPrivateKey(privatePem)) || !cert.subject.split('\n').includes('CN=1749999844')) throw new Error('Wrong merchant certificate');
if (Buffer.byteLength(apiKey) !== 32 || createPublicKey(publicPem).asymmetricKeyType !== 'rsa') throw new Error('Invalid credentials');
const bindings = {
  WECHAT_ORDINARY_MCH_ID: '1749999844',
  WECHAT_ORDINARY_APP_ID: 'wx9aef0738067286b3',
  WECHAT_ORDINARY_NOTIFY_URL: 'https://erp.boomeroff.com/api/public/storefront/payments/wechat-notify',
  WECHAT_ORDINARY_PRIVATE_KEY_BASE64: privatePem.toString('base64'),
  WECHAT_ORDINARY_PUBLIC_KEY_BASE64: publicPem.toString('base64'),
  WECHAT_ORDINARY_API_V3_KEY: apiKey,
  WECHAT_ORDINARY_CERT_SERIAL: cert.serialNumber,
  WECHAT_ORDINARY_PUBLIC_KEY_ID: 'PUB_KEY_ID_0117499998442026090800381959004001',
  WECHAT_ORDINARY_RECONCILE_TOKEN: randomBytes(32).toString('hex'),
};
const remote = `
const fs=require('fs');let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{try{
 const fields=JSON.parse(input),path='/var/www/boomer-erp/shared/.env';
 const original=fs.readFileSync(path,'utf8'),stat=fs.statSync(path);
 if(Object.keys(fields).some(k=>new RegExp('^'+k+'=', 'm').test(original)))throw Error('Already configured; explicit rotation review required');
 const mode=original.split(/\\r?\\n/).find(x=>x.startsWith('STOREFRONT_PAYMENT_MODE='));
 if(mode&&!/^STOREFRONT_PAYMENT_MODE=['"]?legacy['"]?$/.test(mode))throw Error('Unexpected existing payment mode');
 const suffix=Date.now(),backup=path+'.before-ordinary-'+suffix,temp=path+'.ordinary-'+suffix;
 fs.writeFileSync(backup,original,{mode:0o600,flag:'wx'});
 const lines=Object.entries(fields).map(([k,v])=>{if(!/^[A-Za-z0-9_]+$/.test(k)||/[\\r\\n'\\\\]/.test(v))throw Error('Invalid environment value');return k+"='"+v+"'";});
 if(!mode)lines.push('STOREFRONT_PAYMENT_MODE=legacy');
 fs.writeFileSync(temp,original+'\\n# Ordinary merchant server bindings; new checkout remains disabled.\\n'+lines.join('\\n')+'\\n',{mode:0o600,flag:'wx'});
 fs.chownSync(temp,stat.uid,stat.gid);fs.renameSync(temp,path);
 console.log(JSON.stringify({configured:true,checkoutEnabled:false,backupCreated:true}));
}catch(_){console.error('Secure provisioning stopped; no credentials logged');process.exitCode=1;}});
`;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', sshKeyPath,
  'ubuntu@150.158.94.248', 'node -e ' + shellQuote(remote)], { input: JSON.stringify(bindings), encoding: 'utf8', timeout: 30000 });
if (result.status !== 0) { console.error('Secure provisioning failed; inspect server without printing bindings'); process.exitCode = 1; }
else {
  const resultData = JSON.parse(result.stdout);
  console.log(JSON.stringify({ configured: resultData.configured === true, checkoutEnabled: resultData.checkoutEnabled === true,
    backupCreated: resultData.backupCreated === true }));
}
