// helm_envd.cpp -- C++ environmental grid-pack validator/replay service.
//
// WX-20 first vertical slice:
//   GET /health                         -> service health and fail-loud counts
//   GET /packs                          -> sanitized grid-pack inventory + diagnostics
//   GET /chunk?pack=<id>&chunk=<key>     -> verified HELMGRID chunk bytes
//
// This is deliberately not a provider adapter, not a renderer, and not a
// monolith. It consumes prepared helm.env.grid.v1 manifests/packs and fails loud
// on missing ranges, checksum mismatches, bad chunk envelopes, unsupported
// compression, unsupported grid origins, and missing chunks. Pan/zoom/scrub UI
// gestures should read local packs through this boundary; they must not cause
// provider calls or gateway substitution.

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <utility>
#include <vector>

#include "ixwebsocket/IXConnectionState.h"
#include "ixwebsocket/IXHttp.h"
#include "ixwebsocket/IXHttpServer.h"
#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

namespace {

using Headers = ix::WebSocketHttpHeaders;
using JsonAllocator = rapidjson::Document::AllocatorType;
using JsonValue = rapidjson::Value;

constexpr const char* kPackSchema = "helm.env.grid.pack.v1";
constexpr const char* kChunkSchema = "helm.env.grid.chunk.v1";
constexpr const char* kEncoding = "helm.env.grid.v1";
constexpr const char* kPayload = "helm.env.grid.chunk.v1";
constexpr const char* kEngine = "helm-envd";
constexpr std::uint64_t kMaxChunkBytes = 64ULL * 1024ULL * 1024ULL;

struct Diagnostic {
  std::string code;
  std::string message;
  std::string pack_id;
  std::string chunk_key;
  std::string severity = "error";
};

struct ChunkRecord {
  std::string key;
  std::string layer;
  std::string tier;
  std::string valid_time;
  std::uint64_t offset = 0;
  std::uint64_t length = 0;
  std::string checksum;
};

struct PackRecord {
  std::string id;
  std::string manifest_path;
  std::string pack_path;
  std::string generated_at;
  std::string provider;
  std::string model;
  std::string run_time;
  std::set<std::string> layers;
  std::set<std::string> tiers;
  std::vector<std::string> valid_times;
  std::map<std::string, ChunkRecord> chunks;
  std::vector<Diagnostic> diagnostics;
};

std::string get_env(const char* name, const std::string& fallback = std::string()) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

bool starts_with(const std::string& value, const std::string& prefix) {
  return value.size() >= prefix.size() && std::equal(prefix.begin(), prefix.end(), value.begin());
}

bool is_abs_path(const std::string& path) {
  return !path.empty() && path[0] == '/';
}

std::string dirname_of(const std::string& path) {
  const std::size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) return ".";
  if (slash == 0) return "/";
  return path.substr(0, slash);
}

std::string basename_of(const std::string& path) {
  const std::size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) return path.empty() ? "manifest" : path;
  if (slash + 1 >= path.size()) return "manifest";
  return path.substr(slash + 1);
}

std::string fallback_pack_id(const std::string& manifest_path) {
  return std::string("manifest:") + basename_of(manifest_path);
}

std::string join_path(const std::string& base, const std::string& child) {
  if (child.empty()) return base;
  if (is_abs_path(child)) return child;
  if (base.empty() || base == ".") return child;
  return base.back() == '/' ? base + child : base + "/" + child;
}

std::string expand_user(std::string path) {
  if (path == "~" || starts_with(path, "~/")) {
    return get_env("HOME", ".") + path.substr(1);
  }
  return path;
}

bool stat_file(const std::string& path, struct stat& st) {
  return ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

std::string read_file_text(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot read file: " + path);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::string read_file_slice(const std::string& path, std::uint64_t offset, std::uint64_t length) {
  if (length > kMaxChunkBytes || length > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
    return std::string();
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::string();
  in.seekg(static_cast<std::streamoff>(offset));
  std::string body;
  body.resize(static_cast<std::size_t>(length));
  in.read(&body[0], static_cast<std::streamsize>(length));
  body.resize(static_cast<std::size_t>(in.gcount()));
  return body;
}

std::vector<std::string> split_csv(const std::string& raw) {
  std::vector<std::string> out;
  std::size_t start = 0;
  while (start <= raw.size()) {
    const std::size_t comma = raw.find(',', start);
    std::string item = raw.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    while (!item.empty() && std::isspace(static_cast<unsigned char>(item.front()))) item.erase(item.begin());
    while (!item.empty() && std::isspace(static_cast<unsigned char>(item.back()))) item.pop_back();
    if (!item.empty()) out.push_back(expand_user(item));
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return out;
}

std::string json_escape(const std::string& value) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.String(value.c_str());
  std::string escaped = buffer.GetString();
  if (escaped.size() >= 2 && escaped.front() == '"' && escaped.back() == '"') {
    escaped = escaped.substr(1, escaped.size() - 2);
  }
  return escaped;
}

void add_string(JsonValue& obj, const char* key, const std::string& value, JsonAllocator& a) {
  JsonValue name(key, a);
  JsonValue text(value.c_str(), a);
  obj.AddMember(name, text, a);
}

void add_string_if(JsonValue& obj, const char* key, const std::string& value, JsonAllocator& a) {
  if (!value.empty()) add_string(obj, key, value, a);
}

void add_u64(JsonValue& obj, const char* key, std::uint64_t value, JsonAllocator& a) {
  JsonValue name(key, a);
  obj.AddMember(name, value, a);
}

void add_bool(JsonValue& obj, const char* key, bool value, JsonAllocator& a) {
  JsonValue name(key, a);
  obj.AddMember(name, value, a);
}

std::string stringify(const JsonValue& value) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  value.Accept(writer);
  return buffer.GetString();
}

std::unique_ptr<rapidjson::Document> parse_json(const std::string& text, const std::string& label) {
  auto doc = std::make_unique<rapidjson::Document>();
  doc->Parse(text.c_str());
  if (doc->HasParseError() || !doc->IsObject()) {
    throw std::runtime_error("invalid JSON object: " + label);
  }
  return doc;
}

std::string rj_string(const JsonValue& obj, const char* key, const std::string& fallback = std::string()) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsString()) return fallback;
  return obj[key].GetString();
}

bool rj_required_string(const JsonValue& obj, const char* key, std::string& out) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsString()) return false;
  out = obj[key].GetString();
  return true;
}

const JsonValue* rj_object(const JsonValue& obj, const char* key) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsObject()) return nullptr;
  return &obj[key];
}

const JsonValue* rj_array(const JsonValue& obj, const char* key) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsArray()) return nullptr;
  return &obj[key];
}

bool rj_u64_array2(const JsonValue& obj, const char* key, std::uint64_t& a, std::uint64_t& b) {
  if (!obj.IsObject() || !obj.HasMember(key) || !obj[key].IsArray() || obj[key].Size() != 2) return false;
  if (!obj[key][0].IsUint64() || !obj[key][1].IsUint64()) return false;
  a = obj[key][0].GetUint64();
  b = obj[key][1].GetUint64();
  return true;
}

std::string url_decode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      const std::string hex = s.substr(i + 1, 2);
      char* end = nullptr;
      const long value = std::strtol(hex.c_str(), &end, 16);
      if (end && *end == '\0') {
        out.push_back(static_cast<char>(value));
        i += 2;
      } else {
        out.push_back(s[i]);
      }
    } else if (s[i] == '+') {
      out.push_back(' ');
    } else {
      out.push_back(s[i]);
    }
  }
  return out;
}

std::string request_path(const std::string& uri) {
  const std::size_t q = uri.find('?');
  return q == std::string::npos ? uri : uri.substr(0, q);
}

std::map<std::string, std::string> parse_query(const std::string& uri) {
  std::map<std::string, std::string> out;
  const std::size_t q = uri.find('?');
  if (q == std::string::npos) return out;
  std::size_t start = q + 1;
  while (start <= uri.size()) {
    const std::size_t amp = uri.find('&', start);
    const std::string pair = uri.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
    const std::size_t eq = pair.find('=');
    if (eq != std::string::npos) out[url_decode(pair.substr(0, eq))] = url_decode(pair.substr(eq + 1));
    else if (!pair.empty()) out[url_decode(pair)] = "";
    if (amp == std::string::npos) break;
    start = amp + 1;
  }
  return out;
}

// Tiny SHA-256 implementation for runtime checksum parity; avoids shelling out
// or adding a new boat dependency.
class Sha256 {
public:
  Sha256() { reset(); }

  void update(const std::uint8_t* data, std::size_t len) {
    for (std::size_t i = 0; i < len; ++i) {
      data_[datalen_++] = data[i];
      if (datalen_ == 64) {
        transform();
        bitlen_ += 512;
        datalen_ = 0;
      }
    }
  }

  std::array<std::uint8_t, 32> final() {
    std::uint32_t i = datalen_;
    if (datalen_ < 56) {
      data_[i++] = 0x80;
      while (i < 56) data_[i++] = 0x00;
    } else {
      data_[i++] = 0x80;
      while (i < 64) data_[i++] = 0x00;
      transform();
      std::fill(data_.begin(), data_.begin() + 56, 0);
    }

    bitlen_ += datalen_ * 8;
    data_[63] = static_cast<std::uint8_t>(bitlen_);
    data_[62] = static_cast<std::uint8_t>(bitlen_ >> 8);
    data_[61] = static_cast<std::uint8_t>(bitlen_ >> 16);
    data_[60] = static_cast<std::uint8_t>(bitlen_ >> 24);
    data_[59] = static_cast<std::uint8_t>(bitlen_ >> 32);
    data_[58] = static_cast<std::uint8_t>(bitlen_ >> 40);
    data_[57] = static_cast<std::uint8_t>(bitlen_ >> 48);
    data_[56] = static_cast<std::uint8_t>(bitlen_ >> 56);
    transform();

    std::array<std::uint8_t, 32> hash {};
    for (i = 0; i < 4; ++i) {
      for (int j = 0; j < 8; ++j) hash[i + j * 4] = static_cast<std::uint8_t>((state_[j] >> (24 - i * 8)) & 0xff);
    }
    return hash;
  }

private:
  void reset() {
    datalen_ = 0;
    bitlen_ = 0;
    state_ = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    data_.fill(0);
  }

  static std::uint32_t rotr(std::uint32_t x, std::uint32_t n) { return (x >> n) | (x << (32 - n)); }
  static std::uint32_t choose(std::uint32_t e, std::uint32_t f, std::uint32_t g) { return (e & f) ^ (~e & g); }
  static std::uint32_t majority(std::uint32_t a, std::uint32_t b, std::uint32_t c) { return (a & b) ^ (a & c) ^ (b & c); }
  static std::uint32_t sig0(std::uint32_t x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
  static std::uint32_t sig1(std::uint32_t x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }
  static std::uint32_t ep0(std::uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
  static std::uint32_t ep1(std::uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }

  void transform() {
    static const std::uint32_t k[64] = {
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    };
    std::uint32_t m[64];
    for (std::uint32_t i = 0, j = 0; i < 16; ++i, j += 4) {
      m[i] = (static_cast<std::uint32_t>(data_[j]) << 24) |
             (static_cast<std::uint32_t>(data_[j + 1]) << 16) |
             (static_cast<std::uint32_t>(data_[j + 2]) << 8) |
             (static_cast<std::uint32_t>(data_[j + 3]));
    }
    for (std::uint32_t i = 16; i < 64; ++i) m[i] = sig1(m[i - 2]) + m[i - 7] + sig0(m[i - 15]) + m[i - 16];

    std::uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    std::uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (std::uint32_t i = 0; i < 64; ++i) {
      const std::uint32_t t1 = h + ep1(e) + choose(e, f, g) + k[i] + m[i];
      const std::uint32_t t2 = ep0(a) + majority(a, b, c);
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
    state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
  }

  std::array<std::uint8_t, 64> data_ {};
  std::array<std::uint32_t, 8> state_ {};
  std::uint32_t datalen_ = 0;
  std::uint64_t bitlen_ = 0;
};

std::string sha256_hex(const std::string& body) {
  Sha256 sha;
  sha.update(reinterpret_cast<const std::uint8_t*>(body.data()), body.size());
  const auto digest = sha.final();
  std::ostringstream out;
  for (std::uint8_t b : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(b);
  return out.str();
}

std::uint16_t le16(const char* p) {
  return static_cast<std::uint16_t>(static_cast<unsigned char>(p[0]) |
    (static_cast<unsigned char>(p[1]) << 8));
}

std::uint32_t le32(const char* p) {
  return static_cast<std::uint32_t>(static_cast<unsigned char>(p[0]) |
    (static_cast<unsigned char>(p[1]) << 8) |
    (static_cast<unsigned char>(p[2]) << 16) |
    (static_cast<unsigned char>(p[3]) << 24));
}

void add_diag(PackRecord& pack, std::string code, std::string message, std::string chunk_key = std::string()) {
  Diagnostic d;
  d.code = std::move(code);
  d.message = std::move(message);
  d.pack_id = pack.id;
  d.chunk_key = std::move(chunk_key);
  pack.diagnostics.push_back(std::move(d));
}

bool has_chunk_error(const PackRecord& pack, const std::string& chunk_key) {
  for (const auto& diag : pack.diagnostics) {
    if (diag.severity == "error" && diag.chunk_key == chunk_key) return true;
  }
  return false;
}

bool has_pack_error(const PackRecord& pack) {
  for (const auto& diag : pack.diagnostics) {
    if (diag.severity == "error" && diag.chunk_key.empty()) return true;
  }
  return false;
}

bool checksum_matches(const ChunkRecord& chunk, const std::string& body) {
  return starts_with(chunk.checksum, "sha256:") && sha256_hex(body) == chunk.checksum.substr(7);
}

void validate_chunk_envelope(PackRecord& pack, const ChunkRecord& chunk, const std::string& body) {
  if (body.size() < 16 || std::memcmp(body.data(), "HELMGRID", 8) != 0) {
    add_diag(pack, "bad_chunk_magic", "chunk does not start with HELMGRID magic", chunk.key);
    return;
  }
  const std::uint16_t version = le16(body.data() + 8);
  if (version != 1) {
    add_diag(pack, "unsupported_chunk_version", "chunk version is not supported", chunk.key);
    return;
  }
  const std::uint32_t header_len = le32(body.data() + 12);
  if (16ULL + header_len > body.size()) {
    add_diag(pack, "truncated_chunk_header", "chunk header extends beyond range body", chunk.key);
    return;
  }
  try {
    auto header = parse_json(body.substr(16, header_len), "chunk header " + chunk.key);
    if (rj_string(*header, "schema") != kChunkSchema) {
      add_diag(pack, "bad_chunk_schema", "chunk header schema is not helm.env.grid.chunk.v1", chunk.key);
    }
    if (rj_string(*header, "encoding") != kEncoding) {
      add_diag(pack, "unsupported_encoding", "chunk header encoding is not helm.env.grid.v1", chunk.key);
    }
    if (rj_string(*header, "chunkKey") != chunk.key) {
      add_diag(pack, "chunk_key_mismatch", "chunk header key does not match manifest chunk key", chunk.key);
    }
    std::string endianness;
    if (!rj_required_string(*header, "endianness", endianness)) {
      add_diag(pack, "bad_chunk_endianness", "chunk header endianness must be a string", chunk.key);
    } else if (endianness != "little") {
      add_diag(pack, "unsupported_endianness", "chunk endianness must be little", chunk.key);
    }
    std::string compression;
    if (!rj_required_string(*header, "compression", compression)) {
      add_diag(pack, "bad_chunk_compression", "chunk header compression must be a string", chunk.key);
    } else if (compression != "none") {
      add_diag(pack, "unsupported_compression", "helm-envd first slice only decodes uncompressed chunks", chunk.key);
    }
    const JsonValue* grid = rj_object(*header, "grid");
    if (!grid) {
      add_diag(pack, "missing_grid", "chunk header grid must be an object", chunk.key);
    } else {
      std::string origin;
      if (!rj_required_string(*grid, "origin", origin)) {
        add_diag(pack, "bad_grid_origin", "grid.origin must be a string", chunk.key);
      } else if (origin != "northwest") {
        add_diag(pack, "unsupported_grid_origin", "grid.origin must be northwest", chunk.key);
      }
    }
  } catch (const std::exception& e) {
    add_diag(pack, "bad_chunk_header", e.what(), chunk.key);
  }
}

void validate_chunk_bytes(PackRecord& pack, const ChunkRecord& chunk) {
  if (chunk.length > kMaxChunkBytes) {
    add_diag(pack, "chunk_too_large", "chunk byte range exceeds helm-envd safety limit", chunk.key);
    return;
  }
  const std::string body = read_file_slice(pack.pack_path, chunk.offset, chunk.length);
  if (body.size() != chunk.length) {
    add_diag(pack, "missing_range", "pack byte range is missing or short", chunk.key);
    return;
  }
  if (!starts_with(chunk.checksum, "sha256:")) {
    add_diag(pack, "missing_checksum", "chunk does not declare sha256 checksum", chunk.key);
  } else if (!checksum_matches(chunk, body)) {
      add_diag(pack, "checksum_mismatch", "chunk sha256 checksum mismatch", chunk.key);
  }
  validate_chunk_envelope(pack, chunk, body);
}

PackRecord load_pack_manifest(const std::string& manifest_path) {
  PackRecord pack;
  pack.manifest_path = manifest_path;
  pack.id = fallback_pack_id(manifest_path);
  try {
    auto doc = parse_json(read_file_text(manifest_path), basename_of(manifest_path));
    const std::string declared_pack_id = rj_string(*doc, "packId");
    if (!declared_pack_id.empty()) pack.id = declared_pack_id;
    pack.generated_at = rj_string(*doc, "generatedAt");

    if (rj_string(*doc, "schema") != kPackSchema) add_diag(pack, "bad_manifest_schema", "manifest schema is not helm.env.grid.pack.v1");
    if (rj_string(*doc, "encoding") != kEncoding) add_diag(pack, "unsupported_encoding", "manifest encoding is not helm.env.grid.v1");

    if (const JsonValue* source = rj_object(*doc, "source")) {
      pack.provider = rj_string(*source, "provider");
      pack.model = rj_string(*source, "model");
    }
    if (const JsonValue* run = rj_object(*doc, "run")) {
      pack.run_time = rj_string(*run, "runTime");
      if (const JsonValue* times = rj_array(*run, "validTimes")) {
        for (auto& v : times->GetArray()) if (v.IsString()) pack.valid_times.push_back(v.GetString());
      }
    }
    if (const JsonValue* layers = rj_object(*doc, "layers")) {
      for (auto it = layers->MemberBegin(); it != layers->MemberEnd(); ++it) if (it->name.IsString()) pack.layers.insert(it->name.GetString());
    }
    if (const JsonValue* tiers = rj_object(*doc, "tiers")) {
      for (auto it = tiers->MemberBegin(); it != tiers->MemberEnd(); ++it) if (it->name.IsString()) pack.tiers.insert(it->name.GetString());
    }

    const JsonValue* transport = rj_object(*doc, "transport");
    if (!transport) {
      add_diag(pack, "missing_transport", "manifest does not declare transport");
    } else {
      if (rj_string(*transport, "container") != "pmtiles") add_diag(pack, "unsupported_container", "only pmtiles transport is supported");
      if (rj_string(*transport, "payload") != kPayload) add_diag(pack, "unsupported_payload", "transport payload must be helm.env.grid.chunk.v1");
      if (rj_string(*transport, "byteRangeSemantics") != "offset-length") add_diag(pack, "unsupported_byte_range_semantics", "byteRange must be offset-length");
      const std::string pack_url = rj_string(*transport, "packUrl");
      if (pack_url.empty()) add_diag(pack, "missing_pack_url", "transport.packUrl is required");
      else pack.pack_path = join_path(dirname_of(manifest_path), pack_url);
    }

    struct stat st {};
    if (pack.pack_path.empty() || !stat_file(pack.pack_path, st)) {
      add_diag(pack, "missing_pack", "pack archive is missing");
    }

    const JsonValue* chunks = rj_object(*doc, "chunks");
    if (!chunks || chunks->ObjectEmpty()) {
      add_diag(pack, "missing_chunks", "manifest has no chunk index");
    } else {
      for (auto it = chunks->MemberBegin(); it != chunks->MemberEnd(); ++it) {
        if (!it->name.IsString() || !it->value.IsObject()) continue;
        ChunkRecord chunk;
        chunk.key = it->name.GetString();
        chunk.layer = rj_string(it->value, "layer");
        chunk.tier = rj_string(it->value, "tier");
        chunk.valid_time = rj_string(it->value, "validTime");
        chunk.checksum = rj_string(it->value, "checksum");
        if (rj_string(it->value, "schema") != kChunkSchema) {
          add_diag(pack, "bad_chunk_schema", "manifest chunk schema is not helm.env.grid.chunk.v1", chunk.key);
        }
        if (!rj_u64_array2(it->value, "byteRange", chunk.offset, chunk.length) || chunk.length == 0) {
          add_diag(pack, "bad_byte_range", "chunk byteRange must be [offset,length] with positive length", chunk.key);
        } else if (chunk.length > kMaxChunkBytes) {
          add_diag(pack, "chunk_too_large", "chunk byteRange exceeds helm-envd safety limit", chunk.key);
        }
        pack.chunks[chunk.key] = chunk;
      }
    }

    if (pack.diagnostics.empty() || !pack.pack_path.empty()) {
      for (const auto& item : pack.chunks) validate_chunk_bytes(pack, item.second);
    }
  } catch (const std::exception& e) {
    add_diag(pack, "invalid_manifest", "manifest could not be read or parsed");
  }
  return pack;
}

std::vector<PackRecord> load_packs() {
  std::vector<PackRecord> packs;
  for (const std::string& path : split_csv(get_env("HELM_ENV_GRID_MANIFESTS"))) {
    packs.push_back(load_pack_manifest(path));
  }
  return packs;
}

std::size_t error_count(const PackRecord& pack) {
  return static_cast<std::size_t>(std::count_if(pack.diagnostics.begin(), pack.diagnostics.end(),
    [](const Diagnostic& d) { return d.severity == "error"; }));
}

std::size_t error_count(const std::vector<PackRecord>& packs) {
  std::size_t total = 0;
  for (const auto& pack : packs) total += error_count(pack);
  return total;
}

void add_string_array(JsonValue& obj, const char* key, const std::set<std::string>& values, JsonAllocator& a) {
  JsonValue arr(rapidjson::kArrayType);
  for (const auto& item : values) {
    JsonValue text(item.c_str(), a);
    arr.PushBack(text, a);
  }
  JsonValue name(key, a);
  obj.AddMember(name, arr, a);
}

void add_string_vector(JsonValue& obj, const char* key, const std::vector<std::string>& values, JsonAllocator& a) {
  JsonValue arr(rapidjson::kArrayType);
  for (const auto& item : values) {
    JsonValue text(item.c_str(), a);
    arr.PushBack(text, a);
  }
  JsonValue name(key, a);
  obj.AddMember(name, arr, a);
}

JsonValue diagnostic_json(const Diagnostic& diag, JsonAllocator& a) {
  JsonValue obj(rapidjson::kObjectType);
  add_string(obj, "code", diag.code, a);
  add_string(obj, "message", diag.message, a);
  add_string_if(obj, "packId", diag.pack_id, a);
  add_string_if(obj, "chunkKey", diag.chunk_key, a);
  add_string(obj, "severity", diag.severity, a);
  return obj;
}

JsonValue pack_json(const PackRecord& pack, JsonAllocator& a) {
  JsonValue obj(rapidjson::kObjectType);
  add_string(obj, "packId", pack.id, a);
  add_string(obj, "schema", kPackSchema, a);
  add_string(obj, "encoding", kEncoding, a);
  add_string(obj, "status", error_count(pack) ? "error" : "ready", a);
  add_string_if(obj, "generatedAt", pack.generated_at, a);
  add_string_if(obj, "provider", pack.provider, a);
  add_string_if(obj, "model", pack.model, a);
  add_string_if(obj, "runTime", pack.run_time, a);
  add_string_array(obj, "layers", pack.layers, a);
  add_string_array(obj, "tiers", pack.tiers, a);
  add_string_vector(obj, "validTimes", pack.valid_times, a);
  add_u64(obj, "chunkCount", pack.chunks.size(), a);

  JsonValue diagnostics(rapidjson::kArrayType);
  for (const auto& diag : pack.diagnostics) diagnostics.PushBack(diagnostic_json(diag, a), a);
  obj.AddMember("diagnostics", diagnostics, a);
  return obj;
}

std::string inventory_json(const std::vector<PackRecord>& packs) {
  rapidjson::Document doc;
  doc.SetObject();
  auto& a = doc.GetAllocator();
  add_string(doc, "schema", "helm.envd.inventory.v1", a);
  add_string(doc, "engine", kEngine, a);
  add_string(doc, "status", error_count(packs) ? "error" : "ok", a);
  add_u64(doc, "packCount", packs.size(), a);
  add_u64(doc, "errorCount", error_count(packs), a);
  add_bool(doc, "providerFetchDuringGestureAllowed", false, a);
  add_bool(doc, "pngFallbackAllowed", false, a);

  JsonValue arr(rapidjson::kArrayType);
  for (const auto& pack : packs) arr.PushBack(pack_json(pack, a), a);
  doc.AddMember("packs", arr, a);
  return stringify(doc);
}

std::string health_json(const std::vector<PackRecord>& packs) {
  rapidjson::Document doc;
  doc.SetObject();
  auto& a = doc.GetAllocator();
  const std::size_t errors = error_count(packs);
  add_string(doc, "status", errors ? "error" : "ok", a);
  add_string(doc, "engine", kEngine, a);
  add_u64(doc, "packs", packs.size(), a);
  add_u64(doc, "errors", errors, a);
  add_bool(doc, "cacheOnlyReplay", true, a);
  add_bool(doc, "providerFetchDuringGestureAllowed", false, a);
  return stringify(doc);
}

std::string error_json(const std::string& code, const std::string& message) {
  return std::string("{\"error\":\"") + json_escape(code) + "\",\"message\":\"" + json_escape(message) + "\"}";
}

void base_headers(Headers& h) {
  h["Access-Control-Allow-Origin"] = "*";
  h["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
  h["Access-Control-Allow-Headers"] = "Range, Content-Type";
  h["Access-Control-Expose-Headers"] = "Content-Length, X-Helm-Env-Chunk-Key, X-Helm-Env-Pack-Id";
}

ix::HttpResponsePtr response(int status, const std::string& reason, Headers h, std::string body) {
  h["Content-Length"] = std::to_string(body.size());
  return std::make_shared<ix::HttpResponse>(status, reason, ix::HttpErrorCode::Ok, h, body);
}

ix::HttpResponsePtr empty_response(int status, const std::string& reason, Headers h) {
  h["Content-Length"] = "0";
  return std::make_shared<ix::HttpResponse>(status, reason, ix::HttpErrorCode::Ok, h, std::string());
}

ix::HttpResponsePtr empty_response_with_length(int status, const std::string& reason, Headers h, std::uint64_t length) {
  h["Content-Length"] = std::to_string(length);
  return std::make_shared<ix::HttpResponse>(status, reason, ix::HttpErrorCode::Ok, h, std::string());
}

class EnvDaemon {
public:
  EnvDaemon(std::string bind, int port, std::vector<PackRecord> packs)
      : bind_(std::move(bind)), port_(port), packs_(std::move(packs)), server_(port_, bind_) {}

  bool start() {
    server_.setOnConnectionCallback(
      [this](ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
        auto resp = this->handle(req);
        // ixwebsocket serves one request per connection — advertise the close so
        // keep-alive clients don't race a reused socket (BUG-1).
        if (resp) resp->headers["Connection"] = "close";
        return resp;
      });
    return server_.listenAndStart();
  }

private:
  const PackRecord* find_pack(const std::string& pack_id) const {
    for (const auto& pack : packs_) {
      if (pack.id == pack_id) return &pack;
    }
    return nullptr;
  }

  ix::HttpResponsePtr handle_chunk(const ix::HttpRequestPtr& req, Headers h, bool head_only) const {
    const auto query = parse_query(req->uri);
    const auto pit = query.find("pack");
    const auto cit = query.find("chunk");
    h["Content-Type"] = "application/json";
    if (pit == query.end() || cit == query.end() || pit->second.empty() || cit->second.empty()) {
      return response(400, "Bad Request", std::move(h), error_json("bad_chunk_request", "pack and chunk query parameters are required"));
    }
    const PackRecord* pack = find_pack(pit->second);
    if (!pack) return response(404, "Not Found", std::move(h), error_json("unknown_pack", "pack is not installed"));
    const auto chunk_it = pack->chunks.find(cit->second);
    if (chunk_it == pack->chunks.end()) return response(404, "Not Found", std::move(h), error_json("missing_chunk", "chunk is not in the pack manifest"));
    if (has_pack_error(*pack)) {
      return response(409, "Conflict", std::move(h), error_json("invalid_pack", "pack failed startup validation"));
    }
    if (has_chunk_error(*pack, cit->second)) {
      return response(409, "Conflict", std::move(h), error_json("invalid_chunk", "chunk failed startup validation"));
    }
    const std::string body = read_file_slice(pack->pack_path, chunk_it->second.offset, chunk_it->second.length);
    if (body.size() != chunk_it->second.length) {
      return response(409, "Conflict", std::move(h), error_json("missing_range", "chunk range is missing or short"));
    }
    if (!checksum_matches(chunk_it->second, body)) {
      return response(409, "Conflict", std::move(h), error_json("checksum_mismatch", "chunk bytes changed after startup validation"));
    }
    h["Content-Type"] = "application/octet-stream";
    h["Cache-Control"] = "private, max-age=86400";
    h["X-Helm-Env-Pack-Id"] = pack->id;
    h["X-Helm-Env-Chunk-Key"] = chunk_it->second.key;
    if (head_only) return empty_response_with_length(200, "OK", std::move(h), chunk_it->second.length);
    return response(200, "OK", std::move(h), body);
  }

  ix::HttpResponsePtr handle(const ix::HttpRequestPtr& req) const {
    Headers h;
    base_headers(h);
    const std::string path = request_path(req->uri);
    const bool is_head = req->method == "HEAD";
    if (req->method == "OPTIONS") return empty_response(204, "No Content", std::move(h));
    if (req->method != "GET" && !is_head) return empty_response(405, "Method Not Allowed", std::move(h));

    if (path == "/" || path == "/health") {
      h["Content-Type"] = "application/json";
      h["Cache-Control"] = "no-store";
      const std::string body = health_json(packs_);
      if (is_head) return empty_response(200, "OK", std::move(h));
      return response(200, "OK", std::move(h), body);
    }
    if (path == "/packs") {
      h["Content-Type"] = "application/json";
      h["Cache-Control"] = "no-store";
      const std::string body = inventory_json(packs_);
      if (is_head) return empty_response(200, "OK", std::move(h));
      return response(200, "OK", std::move(h), body);
    }
    if (path == "/chunk") return handle_chunk(req, std::move(h), is_head);
    return empty_response(404, "Not Found", std::move(h));
  }

  std::string bind_;
  int port_;
  std::vector<PackRecord> packs_;
  ix::HttpServer server_;
};

}  // namespace

int main(int argc, char** argv) {
  const int port = argc > 1 ? std::atoi(argv[1]) : 8094;
  const std::string bind = get_env("HELM_BIND", "127.0.0.1");
  auto packs = load_packs();
  if (packs.empty()) {
    std::fprintf(stderr, "FATAL: no helm.env.grid.v1 manifests configured\n");
    std::fprintf(stderr, "Set HELM_ENV_GRID_MANIFESTS to one or more comma-separated packed manifest paths.\n");
    return 1;
  }

  EnvDaemon daemon(bind, port, std::move(packs));
  if (!daemon.start()) {
    std::fprintf(stderr, "helm-envd listen on %s:%d FAILED\n", bind.c_str(), port);
    return 2;
  }
  std::printf("helm-envd environmental grid-pack service: http://%s:%d/\n", bind.c_str(), port);
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
  return 0;
}
