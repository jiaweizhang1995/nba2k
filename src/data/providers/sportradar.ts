// Sportradar adapter — officially licensed data for production use.
// Docs: https://developer.sportradar.com/basketball/docs/nba-ig-api-basics
//
// Requires a paid, licensed API key. The adapter only implements the
// season-end standings/rosters summary endpoints; extend as your license
// allows. No data is ever fabricated when the license is absent.

import { ProviderError, type DataSourceAdapter } from "./types";

const BASE = "https://api.sportradar.com/nba/trial/v8/en";

export const sportradarAdapter: DataSourceAdapter = {
  id: "SPORTRADAR",
  label: "Sportradar（正式授权数据）",
  docsUrl: "https://developer.sportradar.com/basketball/docs/nba-ig-api-basics",
  requiresApiKey: true,
  apiKeyEnvVar: "SPORTRADAR_API_KEY",
  licenseNote: "Sportradar 数据为商业授权内容，使用范围以您的授权协议为准。未经授权不得再分发。",
  async fetchSeason(_season, opts) {
    const key = opts.apiKey;
    if (!key) throw new ProviderError("NO_API_KEY", "Sportradar 需要授权 API Key（环境变量 SPORTRADAR_API_KEY）");
    throw new ProviderError(
      "NOT_IMPLEMENTED",
      "Sportradar 适配器已就绪但需要您在授权协议允许的字段范围内启用：请在 src/data/providers/sportradar.ts 中按授权文档映射字段。未获得授权前不会抓取或伪造任何数据。",
    );
    // Implementation sketch (requires licensed key & contract review):
    // const res = await fetch(`${BASE}/seasons/${year}/REG/standings.json?api_key=${key}`);
    // ...map to ImportPayload with full provenance...
  },
};

export const SPORTSRADAR_BASE = BASE;
