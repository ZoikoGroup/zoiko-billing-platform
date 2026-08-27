import re

with open('app/modules/chatbot/conversation/engine.py', 'r') as f:
    content = f.read()

# Find lines with 'invoice' in the lower 3300-3400 range
lines = content.split('\n')
for i, line in enumerate(lines[3299:3399], start=3300):
    if 'invoice' in line.lower():
        print(f'{i}: {line}')