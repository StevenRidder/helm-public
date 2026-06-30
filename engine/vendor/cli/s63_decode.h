#ifndef HELM_S63_DECODE_H
#define HELM_S63_DECODE_H
// CHART-12: headless IHO S-63 Data Protection Scheme ENC decrypt.
//
// Decrypts an S-63 encrypted ENC cell to a plain S-57 (ISO/IEC 8211) file that the existing
// s57chart->Init(FULL_INIT) path renders unchanged. Key hierarchy (S-63 Ed1.2):
//   USERPERMIT + M_KEY -> HW_ID ;  HW_ID6 = HW_ID + HW_ID[0] ;  PERMIT(ECK) + HW_ID6 -> Cell Key ;
//   encrypted .000 + Cell Key (Blowfish-ECB) -> ZIP -> raw-inflate -> S-57.
// Crypto = OpenSSL low-level Blowfish (ECB) + zlib raw inflate (both already linked into the engine).
// Keys are RAW ASCII bytes (M_KEY "10121", HW_ID "12345", HW_ID6 "123451") — NOT hex-decoded; only the
// ECK/CRC permit fields are hex. The decrypted cell key MUST be truncated to 5 bytes (8 bytes fails).
// Signature authentication (DSA-SHA1 over the IHO SA key) is a separate authenticity gate, not needed
// to decrypt+render — deferred. Free IHO test params (S-64, no licence): HELM_S63_HWID=12345,
// HELM_S63_USERPERMIT=66B5CBFDF7E4139D5B6086C23130, HELM_S63_MKEY=10121. Never ship test keys live.
#include <string>
#include <map>
#include <vector>
#include <utility>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <fstream>
#include <iterator>
#define OPENSSL_SUPPRESS_DEPRECATED
#include <openssl/blowfish.h>
#include <zlib.h>

namespace s63 {

inline std::vector<unsigned char> hex2bytes(const std::string& h) {
  auto v = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  std::vector<unsigned char> out;
  for (size_t i = 0; i + 1 < h.size(); i += 2) {
    int hi = v(h[i]), lo = v(h[i + 1]);
    if (hi < 0 || lo < 0) break;
    out.push_back((unsigned char)((hi << 4) | lo));
  }
  return out;
}

// Blowfish-ECB decrypt `n` bytes (n a multiple of 8) with `key` used as raw bytes.
inline std::vector<unsigned char> bf_decrypt(const unsigned char* in, size_t n, const std::string& key) {
  BF_KEY bk; BF_set_key(&bk, (int)key.size(), (const unsigned char*)key.data());
  std::vector<unsigned char> out(n - (n % 8));
  for (size_t i = 0; i + 8 <= n; i += 8)
    BF_ecb_encrypt(in + i, out.data() + i, &bk, BF_DECRYPT);
  return out;
}

// USERPERMIT (>=16 hex chars = encrypted HW_ID) + manufacturer key -> 5-char HW_ID.
inline std::string userpermit_to_hwid(const std::string& userpermit, const std::string& mkey) {
  if (userpermit.size() < 16) return "";
  std::vector<unsigned char> enc = hex2bytes(userpermit.substr(0, 16));
  if (enc.size() != 8) return "";
  std::vector<unsigned char> dec = bf_decrypt(enc.data(), 8, mkey);
  return std::string((const char*)dec.data(), 5);   // first 5 bytes = HW_ID
}

// A 16-hex Encrypted Cell Key + HW_ID6 -> 5-byte cell key (TRUNCATED to 5 — load-bearing).
inline std::vector<unsigned char> decrypt_cell_key(const std::string& eck_hex, const std::string& hwid6) {
  std::vector<unsigned char> eck = hex2bytes(eck_hex);
  if (eck.size() != 8) return {};
  std::vector<unsigned char> ck = bf_decrypt(eck.data(), 8, hwid6);
  ck.resize(5);
  return ck;
}

// raw DEFLATE (windowBits -15) inflate of `n` bytes -> out (hint = expected uncompressed size).
inline bool raw_inflate(const unsigned char* in, size_t n, size_t hint, std::vector<unsigned char>& out) {
  z_stream zs; std::memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, -15) != Z_OK) return false;
  out.resize(hint > 0 ? hint : (n ? n * 4 : 4096));
  zs.next_in = (Bytef*)in; zs.avail_in = (uInt)n;
  zs.next_out = out.data(); zs.avail_out = (uInt)out.size();
  int rc;
  for (;;) {
    rc = inflate(&zs, Z_NO_FLUSH);
    if (rc == Z_STREAM_END) break;
    if (rc != Z_OK && rc != Z_BUF_ERROR) break;
    if (zs.avail_out == 0) {                       // grow if the hint was too small
      size_t old = out.size(); out.resize(old * 2);
      zs.next_out = out.data() + old; zs.avail_out = (uInt)(out.size() - old);
    } else if (rc == Z_BUF_ERROR) break;           // no progress + output available -> done/stuck
  }
  bool ok = (rc == Z_STREAM_END);
  out.resize(zs.total_out);
  inflateEnd(&zs);
  return ok;
}

// Decrypt an encrypted S-63 cell (Blowfish-ECB) and unzip its single entry -> plain S-57.
// Probes cell key 1, then cell key 2 (the ZIP local-header signature is the key-validity oracle).
inline bool decrypt_cell(const std::vector<unsigned char>& enc,
                         const std::vector<unsigned char>& ck1,
                         const std::vector<unsigned char>& ck2,
                         std::vector<unsigned char>& s57) {
  if (enc.size() < 8 || (enc.size() % 8) != 0) return false;
  const std::vector<unsigned char> cks[2] = { ck1, ck2 };
  for (int c = 0; c < 2; ++c) {
    if (cks[c].size() != 5) continue;
    const std::string key((const char*)cks[c].data(), 5);
    std::vector<unsigned char> probe = bf_decrypt(enc.data(), 8, key);
    uint32_t sig = probe[0] | (probe[1] << 8) | (probe[2] << 16) | ((uint32_t)probe[3] << 24);
    if (sig != 0x04034b50) continue;               // not a ZIP local file header -> wrong key
    std::vector<unsigned char> zip = bf_decrypt(enc.data(), enc.size(), key);
    if (zip.size() < 30) return false;
    uint16_t method  = zip[8]  | (zip[9]  << 8);
    uint32_t csize   = zip[18] | (zip[19] << 8) | (zip[20] << 16) | ((uint32_t)zip[21] << 24);
    uint32_t usize   = zip[22] | (zip[23] << 8) | (zip[24] << 16) | ((uint32_t)zip[25] << 24);
    uint16_t namelen = zip[26] | (zip[27] << 8);
    uint16_t extralen= zip[28] | (zip[29] << 8);
    size_t off = 30u + namelen + extralen;
    if (off > zip.size()) return false;
    if ((csize == 0 || usize == 0)) {              // streamed sizes -> read from the central directory
      for (size_t i = 0; i + 46 <= zip.size(); ++i) {
        uint32_t cs = zip[i] | (zip[i+1] << 8) | (zip[i+2] << 16) | ((uint32_t)zip[i+3] << 24);
        if (cs == 0x02014b50) {
          csize = zip[i+20] | (zip[i+21] << 8) | (zip[i+22] << 16) | ((uint32_t)zip[i+23] << 24);
          usize = zip[i+24] | (zip[i+25] << 8) | (zip[i+26] << 16) | ((uint32_t)zip[i+27] << 24);
          break;
        }
      }
    }
    if (method == 0) {                             // stored
      size_t len = usize ? usize : (zip.size() - off);
      if (off + len > zip.size()) len = zip.size() - off;
      s57.assign(zip.begin() + off, zip.begin() + off + len);
      return !s57.empty();
    }
    size_t avail = zip.size() - off;
    size_t clen = csize ? (csize < avail ? csize : avail) : avail;
    return raw_inflate(zip.data() + off, clen, usize, s57);
  }
  return false;                                     // SSE 21: keys invalid
}

// Heuristic: a plain S-57 base cell starts with a 5-digit ASCII ISO-8211 record length;
// an encrypted cell starts with ciphertext. So "first 5 bytes not all digits" => encrypted.
inline bool is_encrypted(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  unsigned char b[5] = {0,0,0,0,0};
  f.read((char*)b, 5);
  if (f.gcount() < 5) return false;
  for (int i = 0; i < 5; ++i) if (b[i] < '0' || b[i] > '9') return true;
  return false;
}

inline std::map<std::string, std::pair<std::string, std::string>> parse_permit_file(const std::string& text) {
  std::map<std::string, std::pair<std::string, std::string>> m;
  size_t pos = 0;
  while (pos < text.size()) {
    size_t nl = text.find('\n', pos);
    std::string line = text.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
    pos = (nl == std::string::npos) ? text.size() : nl + 1;
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty() || line[0] == ':') continue;                 // section/header markers
    size_t comma = line.find(',');
    std::string p = (comma == std::string::npos) ? line : line.substr(0, comma);
    if (p.size() < 48) continue;
    std::string name = p.substr(0, 8);
    while (!name.empty() && name.back() == ' ') name.pop_back();
    std::string eck1 = p.substr(16, 16), eck2 = p.substr(32, 16);
    bool hex = !name.empty();
    for (char ch : (eck1 + eck2)) if (!std::isxdigit((unsigned char)ch)) { hex = false; break; }
    if (hex) m[name] = std::make_pair(eck1, eck2);
  }
  return m;
}

// One S-63 decoder configured from the environment, shared per server.
struct Decoder {
  std::string hwid6;                                              // empty => disabled
  std::map<std::string, std::pair<std::string, std::string>> permits;

  bool enabled() const { return hwid6.size() == 6 && !permits.empty(); }

  static Decoder from_env() {
    Decoder d;
    const char* permit = std::getenv("HELM_S63_PERMIT");
    if (!permit || !*permit) return d;
    std::ifstream f(permit, std::ios::binary);
    if (!f) { std::fprintf(stderr, "S-63: cannot read HELM_S63_PERMIT=%s\n", permit); return d; }
    std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    d.permits = parse_permit_file(text);
    std::string hwid;
    if (const char* h = std::getenv("HELM_S63_HWID")) if (*h) hwid = h;
    if (hwid.empty()) {
      const char* up = std::getenv("HELM_S63_USERPERMIT");
      const char* mk = std::getenv("HELM_S63_MKEY");
      if (up && *up && mk && *mk) hwid = userpermit_to_hwid(up, mk);
    }
    if (hwid.size() >= 5) d.hwid6 = hwid.substr(0, 5) + hwid.substr(0, 1);   // HW_ID + first byte
    std::fprintf(stderr, "S-63: %zu cell permit(s) loaded; HW_ID %s\n",
                 d.permits.size(), d.hwid6.empty() ? "(none — set HELM_S63_HWID)" : "ok");
    return d;
  }

  // Decrypt encrypted `cell_path` (lookup key = `cellname`) to plain S-57 at `out_path`.
  bool decrypt_to_file(const std::string& cell_path, const std::string& cellname,
                       const std::string& out_path, std::string& err) const {
    auto it = permits.find(cellname);
    if (it == permits.end()) { err = "no permit for " + cellname; return false; }
    std::ifstream f(cell_path, std::ios::binary);
    if (!f) { err = "open " + cell_path; return false; }
    std::vector<unsigned char> enc((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (enc.size() < 8 || (enc.size() % 8) != 0) { err = "bad encrypted size"; return false; }
    std::vector<unsigned char> ck1 = decrypt_cell_key(it->second.first, hwid6);
    std::vector<unsigned char> ck2 = decrypt_cell_key(it->second.second, hwid6);
    std::vector<unsigned char> s57;
    if (!decrypt_cell(enc, ck1, ck2, s57)) { err = "SSE 21: cell keys invalid"; return false; }
    std::ofstream o(out_path, std::ios::binary | std::ios::trunc);
    if (!o) { err = "write " + out_path; return false; }
    o.write((const char*)s57.data(), (std::streamsize)s57.size());
    if (!o) { err = "write failed"; return false; }
    return true;
  }
};

}  // namespace s63
#endif
