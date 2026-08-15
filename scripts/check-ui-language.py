# CLAUDE.md の「UI 言語ポリシー」を機械的に検査する。
#
# ユーザに見える文字列はすべて英語。日本語が許されるのは開発者向けコメントだけ。
# レビューのたびに手で grep するのは漏れるので、スクリプトにしてある。
#
#   python scripts/check-ui-language.py     # 0 件なら OK。件数と場所を出す
#
# 検査対象: .vue の <template> 内の
#   - 素のテキストノード
#   - label / placeholder / title / hint / text / tooltip 属性の値
# コメント (<!-- -->, /* */, //) は除外する。
# alert/confirm/prompt/fillText の日本語は別途 grep で確認すること
# (2026-08-12 時点でこちらは 0 件)。
#
# **注意**: Windows の cmd/PowerShell では日本語がそのまま出ると化けるので、
# 検出行は unicode_escape で出力している。場所さえ分かれば十分。

import io,os,re
jp = re.compile(r'[぀-ヿ一-龯]')
attr = re.compile(r'\b(label|placeholder|title|hint|text|tooltip)\s*=\s*"([^"]*)"')
def strip_comments(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    return src
tpl_hits=[]; attr_hits=[]
for root,dirs,files in os.walk('src'):
    dirs[:] = [d for d in dirs if d != 'node_modules']
    for f in files:
        if not f.endswith('.vue'): continue
        p = os.path.join(root,f).replace(os.sep, '/')
        raw = io.open(p, encoding='utf-8', errors='replace').read()
        m = re.search(r'<template>(.*)</template>', raw, flags=re.S)
        if not m: continue
        tpl = strip_comments(m.group(1))
        for a in attr.finditer(tpl):
            if jp.search(a.group(2)):
                attr_hits.append((p, a.group(0)[:100]))
        for t in re.findall(r'>([^<>{}]+)<', tpl):
            if jp.search(t) and t.strip():
                tpl_hits.append((p, t.strip()[:80]))
print('template text nodes with Japanese: %d' % len(tpl_hits))
for p,t in tpl_hits[:15]:
    print('   %s :: %s' % (p, t.encode('unicode_escape').decode()[:110]))
print('attributes with Japanese: %d' % len(attr_hits))
for p,t in attr_hits[:15]:
    print('   %s :: %s' % (p, t.encode('unicode_escape').decode()[:110]))
