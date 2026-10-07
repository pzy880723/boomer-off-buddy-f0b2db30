# channel-sync-worker（腾讯模板，Lovable 不部署）
1. 拷贝 `run-channel-sync-worker.sh` → `/opt/boomer-erp/bin/`；`.service/.timer` → `/etc/systemd/system/`。
2. 写 `/etc/boomer-erp/channel-sync-worker.env`（600）。
3. 先 canary：`CANARY_SKU_ID=<uuid> CANARY_ACTION=delist LIMIT=1 /opt/boomer-erp/bin/run-channel-sync-worker.sh`（以 env 文件变量运行），核对返回与 channel_sync_outbox。
4. 确认后 `systemctl enable --now boomer-channel-sync-worker.timer`。
5. Lovable 侧 pg_cron `channel-sync-worker-tick`（jobid 3）保持 inactive，不要恢复。原配置：每分钟 POST project--…lovable.app/api/public/hooks/channel-sync-worker，无鉴权头（新版本会 401）。
