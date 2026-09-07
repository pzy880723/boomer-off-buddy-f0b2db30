import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, test } from "node:test";

import { verifyConsumerJwt } from "./consumer-auth.server";

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = "consumer-key-1";
  const jwk = publicKey.export({ format: "jwk" });
  const issue = (payload: Record<string, unknown>) => {
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const body = base64url(JSON.stringify(payload));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey);
    return `${header}.${body}.${signature.toString("base64url")}`;
  };
  return {
    issue,
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
  };
}

describe("Tencent consumer JWT verification", () => {
  test("accepts a valid phone or WeChat consumer identity", async () => {
    const { issue, jwks } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const token = issue({
      iss: "https://auth.boomeroff.com",
      aud: "boomer-off-consumer",
      sub: "consumer-001",
      exp: now + 300,
      iat: now,
      phone: "13800001111",
      providers: ["phone", "wechat"],
      wechat_openid: "app-openid",
      wechat_mini_openid: "mini-openid",
      wechat_mini_appid: "wx-mini",
    });

    const identity = await verifyConsumerJwt(token, {
      issuer: "https://auth.boomeroff.com",
      audience: "boomer-off-consumer",
      jwks: async () => jwks,
    });

    assert.equal(identity.subject, "consumer-001");
    assert.equal(identity.phone, "13800001111");
    assert.deepEqual(identity.providers, ["phone", "wechat"]);
    assert.equal(identity.wechatMiniOpenId, "mini-openid");
    assert.equal(identity.wechatMiniAppId, "wx-mini");
    assert.equal(identity.wechatOpenId, "app-openid");
  });

  test("rejects a token from another issuer", async () => {
    const { issue, jwks } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const token = issue({
      iss: "https://attacker.example",
      aud: "boomer-off-consumer",
      sub: "consumer-001",
      exp: now + 300,
    });

    await assert.rejects(
      verifyConsumerJwt(token, {
        issuer: "https://auth.boomeroff.com",
        audience: "boomer-off-consumer",
        jwks: async () => jwks,
      }),
      /issuer/i,
    );
  });

  test("never treats an APP OpenID or incomplete mini-program claims as a payment identity", async () => {
    const { issue, jwks } = fixture();
    for (const claims of [
      {},
      { wechat_mini_openid: "mini-openid" },
      { wechat_mini_appid: "wx-mini" },
      { wechat_mini_openid: "", wechat_mini_appid: "wx-mini" },
      { wechat_mini_openid: 42, wechat_mini_appid: "wx-mini" },
      { wechat_mini_openid: "mini-openid", wechat_mini_appid: ["wx-mini"] },
    ]) {
      const identity = await verifyConsumerJwt(issue({
        iss: "https://auth.boomeroff.com", aud: "boomer-off-consumer",
        sub: "consumer-001", exp: Math.floor(Date.now() / 1000) + 300,
        wechat_openid: "app-openid", ...claims,
      }), {
        issuer: "https://auth.boomeroff.com", audience: "boomer-off-consumer", jwks: async () => jwks,
      });
      assert.equal(identity.wechatMiniOpenId, null);
      assert.equal(identity.wechatMiniAppId, null);
      assert.equal(identity.wechatOpenId, "app-openid");
    }
  });

  test("rejects an expired token", async () => {
    const { issue, jwks } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const token = issue({
      iss: "https://auth.boomeroff.com",
      aud: "boomer-off-consumer",
      sub: "consumer-001",
      exp: now - 1,
    });

    await assert.rejects(
      verifyConsumerJwt(token, {
        issuer: "https://auth.boomeroff.com",
        audience: "boomer-off-consumer",
        jwks: async () => jwks,
      }),
      /expired/i,
    );
  });
});
