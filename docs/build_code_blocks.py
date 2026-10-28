import re
import io
import sys

path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()


def width_of(s):
    return sum(2 if ord(c) > 0x2E80 else 1 for c in s)


def repl(m):
    body = m.group(1)
    lines = body.split('\n')
    # 去掉首尾因模板缩进产生的空行
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    out = []
    n = len(lines)
    for i, ln in enumerate(lines):
        ln = ln.rstrip()
        cls = 'code'
        if i == 0:
            cls += ' code-first'
        if i == n - 1:
            cls += ' code-last'
        if not ln.strip():
            out.append('<p class="%s">&#160;</p>' % cls)
            continue
        lead = len(ln) - len(ln.lstrip(' '))
        indent = '&#160;' * lead
        rest = ln[lead:]
        if width_of(ln) <= 76:
            rest = rest.replace(' ', '&#160;')
        out.append('<p class="%s">%s%s</p>' % (cls, indent, rest))
    return '\n'.join(out)


new, cnt = re.subn(r'<pre class="code-block">(.*?)</pre>', repl, src, flags=re.S)
io.open(path, 'w', encoding='utf-8').write(new)
print('blocks converted:', cnt)
