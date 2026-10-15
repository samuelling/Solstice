#!/usr/bin/env python3
"""
Build the claude.ai artifact page from index.html.

The artifact host wraps the page in its own <html>/<head>/<body>, blocks
every outside fetch, and gives the page Claude through the `sample`
capability, so: strip the document wrapper and drop Tesseract (Claude reads
the stones there). The scripts, styles and data/burials.json are published
alongside the page as supporting files.
"""
import os, re

ROOT = os.path.join(os.path.dirname(__file__), '..')
src = open(os.path.join(ROOT, 'index.html')).read()

head = re.search(r'<head>(.*?)</head>', src, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', src, re.S).group(1)

# Keep the title, description, fonts, stylesheet; drop charset/viewport (the host adds them).
keep = [l for l in head.strip().splitlines()
        if not re.search(r'charset|name="viewport"|theme-color|rel="icon"', l)]
body = re.sub(r'\s*<script src="https://cdn\.jsdelivr\.net/npm/tesseract[^"]*"></script>', '', body)

os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
out = os.path.join(ROOT, 'build', 'artifact.html')
with open(out, 'w') as f:
    f.write('\n'.join(l.strip() for l in keep) + '\n' + body.strip() + '\n')
print('wrote', out)
