const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "boomer-off-buddy",
      cwd: __dirname,
      script: path.join(__dirname, "scripts/run-tencent-erp.sh"),
      interpreter: "/bin/bash",
      env: {
        NODE_ENV: "production",
        ERP_BIND_HOST: "127.0.0.1",
        ERP_PORT: "3005",
      },
    },
  ],
};
