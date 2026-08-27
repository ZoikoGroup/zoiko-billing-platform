import re

with open('app/modules/chatbot/conversation/engine.py', 'r') as f:
    content = f.read()

lines = content.split('\n')
# Find _list_invoices method
for i, line in enumerate(lines[6100:6200], start=6101):
    if 'def _list_invoices' in line or 'def _count_invoices' in line or 'def _handle' in line:
        print(f'{i}: {line}')