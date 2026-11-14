import crypto from 'node:crypto';
import pg from 'pg';

const {Pool}=pg;
const AAD=Buffer.from('DhanPulse/FYERS/access-token/v1','utf8');

export function createSharedTokenReader({databaseUrl,encryptionKey}){
  const url=String(databaseUrl||'').trim(),raw=String(encryptionKey||'').trim();
  if(!/^postgres(?:ql)?:\/\//i.test(url)||!/^[a-f0-9]{64}$/i.test(raw))return null;
  const key=Buffer.from(raw,'hex');
  const pool=new Pool({connectionString:url,max:1,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,application_name:'gv2vpd-workstation-token-reader'});
  return {
    async read(){
      const r=await pool.query('SELECT encrypted_token,iv,auth_tag,authenticated_at FROM dhanpulse_fyers_auth WHERE id=1');
      if(!r.rows.length)return null;
      const row=r.rows[0],decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(row.iv,'base64'));
      decipher.setAAD(AAD);decipher.setAuthTag(Buffer.from(row.auth_tag,'base64'));
      const accessToken=Buffer.concat([decipher.update(Buffer.from(row.encrypted_token,'base64')),decipher.final()]).toString('utf8');
      if(!accessToken)return null;
      return {accessToken,authenticatedAt:new Date(row.authenticated_at).toISOString()};
    },
    async save(accessToken,authenticatedAt){
      const token=String(accessToken||'').trim();if(!token)throw new Error('Refusing to persist an empty FYERS access token.');
      const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);
      const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
      await pool.query('INSERT INTO dhanpulse_fyers_auth (id,encrypted_token,iv,auth_tag,authenticated_at,updated_at) VALUES (1,$1,$2,$3,$4::timestamptz,NOW()) ON CONFLICT (id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,authenticated_at=EXCLUDED.authenticated_at,updated_at=NOW()',[encrypted.toString('base64'),iv.toString('base64'),cipher.getAuthTag().toString('base64'),authenticatedAt]);
    },
    close(){return pool.end();}
  };
}
