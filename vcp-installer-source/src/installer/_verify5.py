import io

with io.open('config_gen.rs', 'r', encoding='utf-8', newline='') as f:
    rs = f.read()

fn_idx = rs.find('pub fn generate_start_upgrade_bat')
cs = rs.find('let content = "', fn_idx)
start = cs + len('let content = "')
i = start
chars = []
escapes = {'n': '\n', 'r': '\r', 't': '\t', '"': '"', '\\': '\\', '0': '\0'}
while i < len(rs):
    c = rs[i]
    if c == '\\':
        nxt = rs[i+1] if i+1 < len(rs) else ''
        # Line continuation in Rust: backslash followed by (possible CR) LF
        if nxt in ('\n', '\r'):
            # Check if it's really a continuation (backslash + newline, nothing else on the line)
            # In CRLF file, this is \ followed by \r\n
            i += 2
            if i < len(rs) and rs[i] == '\n':
                i += 1  # skip the LF in CRLF
            continue
        if nxt in escapes:
            chars.append(escapes[nxt])
            i += 2
            continue
        chars.append(c)
        i += 1
        continue
    if c == '"':
        break
    chars.append(c)
    i += 1
rust_bat = ''.join(chars)

with io.open('D:/Desktop/vcp-installer-test/VCP_AIOS/start-upgrade.bat', 'rb') as f:
    test_bat = f.read().decode('utf-8')

print(f'Rust: {len(rust_bat)} chars, CRLF={rust_bat.count(chr(13)+chr(10))}')
print(f'Test: {len(test_bat)} chars, CRLF={test_bat.count(chr(13)+chr(10))}')

# Normalize line endings
r_norm = rust_bat.replace('\r\n', '\n').rstrip('\n')
t_norm = test_bat.replace('\r\n', '\n').rstrip('\n')

rl = r_norm.split('\n')
tl = t_norm.split('\n')
print(f'Rust lines: {len(rl)}, Test lines: {len(tl)}')

mm = 0
for i in range(max(len(rl), len(tl))):
    a = rl[i].strip() if i < len(rl) else '<missing>'
    b = tl[i].strip() if i < len(tl) else '<missing>'
    if a != b:
        mm += 1
        if mm <= 5:
            print(f'L{i+1} R: {a[:80]}')
            print(f'L{i+1} T: {b[:80]}')
print('MISMATCHES:', mm)
if mm == 0 and len(rl) == len(tl):
    print('==> PERFECT MATCH')
