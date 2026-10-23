-- Prepended to every script `defineCommand` registers on an ioredis-mock client.
--
-- ioredis-mock runs scripts in fengari, a Lua 5.3 VM, with nothing but `redis.call` and
-- `redis.pcall` defined. BullMQ's scripts are written for Redis's Lua 5.1 and its bundled
-- libraries. This fills the gap — see `server/testing/redis-mock.ts` for the why of each
-- part. The script itself runs inside the function at the bottom, and its reply is handed
-- back to JavaScript as JSON.

-- ── Numbers ─────────────────────────────────────────────────────────────────
-- fengari integers are 32-bit and wrap on overflow, so a millisecond timestamp held as one
-- is corrupted by the first multiplication. Redis's Lua 5.1 has only doubles; keep every
-- number that enters a script a float to match.

local __tonumber, __floor, __ceil = tonumber, math.floor, math.ceil
tonumber = function(...)
  local n = __tonumber(...)
  return n and n + 0.0
end
math.floor = function(x) return __floor(x) + 0.0 end
math.ceil = function(x) return __ceil(x) + 0.0 end

-- ── cmsgpack (unpack only: BullMQ never packs inside a script) ──────────────

cmsgpack = {}

function cmsgpack.unpack(s)
  local pos = 1
  local function read(fmt)
    local v
    v, pos = string.unpack(fmt, s, pos)
    return v
  end
  -- Assembled from 16-bit halves: a 32-bit read could already overflow a fengari integer.
  local function u32() return read('>I2') * 65536.0 + read('>I2') end
  local function u64() return u32() * 4294967296.0 + u32() end
  local function s32()
    local v = u32()
    return v >= 2147483648 and v - 4294967296.0 or v
  end
  local function s64() return s32() * 4294967296.0 + u32() end
  local function str(n)
    local v = string.sub(s, pos, pos + n - 1)
    pos = pos + n
    return v
  end

  local decode
  local function arr(n)
    local t = {}
    for i = 1, n do t[i] = decode() end
    return t
  end
  local function map(n)
    local t = {}
    for _ = 1, n do
      local k = decode()
      t[k] = decode()
    end
    return t
  end

  decode = function()
    local b = read('B')
    if b <= 0x7f then return b + 0.0
    elseif b >= 0xe0 then return b - 256.0
    elseif b <= 0x8f then return map(b - 0x80)
    elseif b <= 0x9f then return arr(b - 0x90)
    elseif b <= 0xbf then return str(b - 0xa0)
    elseif b == 0xc0 then return nil
    elseif b == 0xc2 then return false
    elseif b == 0xc3 then return true
    elseif b == 0xc4 or b == 0xd9 then return str(read('B'))
    elseif b == 0xc5 or b == 0xda then return str(read('>I2'))
    elseif b == 0xc6 or b == 0xdb then return str(u32())
    elseif b == 0xca then return read('>f')
    elseif b == 0xcb then return read('>d')
    elseif b == 0xcc then return read('B') + 0.0
    elseif b == 0xcd then return read('>I2') + 0.0
    elseif b == 0xce then return u32()
    elseif b == 0xcf then return u64()
    elseif b == 0xd0 then return read('>i1') + 0.0
    elseif b == 0xd1 then return read('>i2') + 0.0
    elseif b == 0xd2 then return s32()
    elseif b == 0xd3 then return s64()
    elseif b == 0xdc then return arr(read('>I2'))
    elseif b == 0xdd then return arr(u32())
    elseif b == 0xde then return map(read('>I2'))
    elseif b == 0xdf then return map(u32())
    end
    error('cmsgpack: unsupported type 0x' .. string.format('%02x', b))
  end

  return decode()
end

-- ── cjson ───────────────────────────────────────────────────────────────────

cjson = {}

local escapes = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

function cjson.encode(v)
  local t = type(v)
  if t == 'nil' then return 'null'
  elseif t == 'boolean' then return tostring(v)
  elseif t == 'number' then return string.format('%.14g', v)
  elseif t == 'string' then
    return '"' .. v:gsub('[%c"\\]', function(c)
      return escapes[c] or string.format('\\u%04x', c:byte())
    end) .. '"'
  elseif t == 'table' then
    local n, count = #v, 0
    for _ in pairs(v) do count = count + 1 end
    local out = {}
    -- Like cjson, an empty table is an object.
    if n > 0 and n == count then
      for i = 1, n do out[i] = cjson.encode(v[i]) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    for k, val in pairs(v) do
      out[#out + 1] = cjson.encode(tostring(k)) .. ':' .. cjson.encode(val)
    end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('cjson: cannot encode a ' .. t)
end

function cjson.decode(s)
  local pos = 1
  local function skip() pos = s:find('[^ \t\r\n]', pos) or #s + 1 end
  local function str()
    local out, i = {}, pos + 1
    while true do
      local c = s:sub(i, i)
      if c == '"' then
        pos = i + 1
        return table.concat(out)
      elseif c == '\\' then
        local e = s:sub(i + 1, i + 1)
        if e == 'u' then
          out[#out + 1] = utf8.char(__tonumber(s:sub(i + 2, i + 5), 16))
          i = i + 6
        else
          out[#out + 1] = ({ b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' })[e] or e
          i = i + 2
        end
      elseif c == '' then
        error('cjson: unterminated string')
      else
        out[#out + 1] = c
        i = i + 1
      end
    end
  end

  local value
  local function list(close, item)
    local t = {}
    pos = pos + 1
    skip()
    if s:sub(pos, pos) == close then
      pos = pos + 1
      return t
    end
    while true do
      item(t)
      skip()
      local c = s:sub(pos, pos)
      pos = pos + 1
      if c == close then return t end
    end
  end

  value = function()
    skip()
    local c = s:sub(pos, pos)
    if c == '{' then
      return list('}', function(t)
        skip()
        local k = str()
        skip()
        pos = pos + 1 -- ':'
        t[k] = value()
      end)
    elseif c == '[' then
      return list(']', function(t) t[#t + 1] = value() end)
    elseif c == '"' then return str()
    elseif s:sub(pos, pos + 3) == 'true' then pos = pos + 4; return true
    elseif s:sub(pos, pos + 4) == 'false' then pos = pos + 5; return false
    elseif s:sub(pos, pos + 3) == 'null' then pos = pos + 4; return nil
    end
    local num = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
    if not num then error('cjson: unexpected character at ' .. pos) end
    pos = pos + #num
    return tonumber(num)
  end

  return value()
end

-- ── redis.* ─────────────────────────────────────────────────────────────────

-- A JavaScript exception surfaces with no message at all; name the command instead.
local __call = redis.call
redis.call = function(...)
  local ok, result = pcall(__call, ...)
  if not ok then error('ERR ' .. tostring((...)) .. ': ' .. tostring(result), 2) end
  return result
end
redis.error_reply = function(msg) return { err = msg } end
redis.status_reply = function(msg) return { ok = msg } end

-- ── The reply ───────────────────────────────────────────────────────────────
-- Converted the way Redis converts a script's return value: numbers truncate to integers,
-- tables become arrays up to the first nil, false becomes nil, true becomes 1.

local function __reply(v)
  local t = type(v)
  if t == 'string' then return cjson.encode(v)
  elseif t == 'number' then return string.format('%.0f', v >= 0 and __floor(v) or __ceil(v))
  elseif t == 'boolean' then return v and '1' or 'null'
  elseif t == 'table' then
    if v.err then return '{"err":' .. cjson.encode(v.err) .. '}' end
    if v.ok then return cjson.encode(v.ok) end
    local out, i = {}, 1
    while v[i] ~= nil do
      out[i] = __reply(v[i])
      i = i + 1
    end
    return '[' .. table.concat(out, ',') .. ']'
  end
  return 'null'
end

return __reply((function()
