import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSecrets } from "../../scripts/check-secrets";

describe("secret scan @E2E-73", () => {
  it("passes a clean dir and fails on planted secrets", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
    try {
      fs.writeFileSync(path.join(d, "ok.ts"), `const x = process.env.SMTP_PASS;\n`);
      expect(scanSecrets(d)).toHaveLength(0);
      fs.writeFileSync(path.join(d, "bad.ts"), `const k = "AKIA${"A".repeat(16)}";\nconst password = "hunter2hunter2";\n`);
      fs.writeFileSync(path.join(d, "key.txt"), `-----BEGIN RSA PRIVATE KEY-----\n`);
      fs.writeFileSync(path.join(d, "h.ts"), `fetch(u,{headers:{Authorization:"Bearer abcdefghijklmnopqrstuvwxyz123456"}})\n`);
      fs.writeFileSync(path.join(d, "m.ts"), `const u = "smtp://user:pw123@mail.example.com";\n`);
      const rules = scanSecrets(d).map((f) => f.rule).sort();
      expect(rules).toEqual(["aws-access-key", "bearer-token", "password-literal", "private-key", "smtp-creds"]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
