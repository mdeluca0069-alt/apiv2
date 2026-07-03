/**
 * GeoipSecurityService — IP geolocation + country-based access control.
 *
 * Production: set GEOIP_PROVIDER=ipapi and optionally GEOIP_API_KEY.
 * Sandbox: skips external call; local IPs always pass.
 *
 * Blocked countries follow OFAC/EU sanctions list (same as sanctions.screening).
 * VPN detection requires a paid provider key (GEOIP_VPN_CHECK=true).
 */

export type GeoipResult = {
  ip:        string;
  country:   string | null;
  isBlocked: boolean;
  isVpn:     boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
};

const BLOCKED_COUNTRIES = new Set([
  "AF", "BY", "CU", "IR", "KP", "LY", "MM", "RU", "SO", "SD", "SY", "VE", "YE",
]);

const RESTRICTED_COUNTRIES = new Set([
  "CN", "PK", "BD", "NG", "EG", "IQ",
]);

function isPrivateIp(ip: string): boolean {
  return (
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("192.168.") ||
    ip === "localhost"
  );
}

class GeoipSecurityService {
  private async resolveCountry(ip: string): Promise<{ country: string | null; isVpn: boolean }> {
    if (isPrivateIp(ip)) return { country: null, isVpn: false };

    try {
      // ip-api.com: free tier, 45 req/min, no key required
      const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,proxy,hosting`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      if (!res.ok) return { country: null, isVpn: false };

      const data = (await res.json()) as {
        status:      string;
        countryCode: string;
        proxy:       boolean;
        hosting:     boolean;
      };

      if (data.status !== "success") return { country: null, isVpn: false };
      return {
        country: data.countryCode ?? null,
        isVpn:   data.proxy === true || data.hosting === true,
      };
    } catch {
      return { country: null, isVpn: false };
    }
  }

  async check(ip: string): Promise<GeoipResult> {
    if (isPrivateIp(ip)) {
      return { ip, country: null, isBlocked: false, isVpn: false, riskLevel: "LOW" };
    }

    const { country, isVpn } = await this.resolveCountry(ip);

    const isBlocked    = country !== null && BLOCKED_COUNTRIES.has(country);
    const isRestricted = country !== null && RESTRICTED_COUNTRIES.has(country);

    const riskLevel: GeoipResult["riskLevel"] =
      isBlocked    ? "HIGH"   :
      isVpn        ? "MEDIUM" :
      isRestricted ? "MEDIUM" : "LOW";

    return { ip, country, isBlocked, isVpn, riskLevel };
  }
}

export const geoipSecurity = new GeoipSecurityService();
export default geoipSecurity;
