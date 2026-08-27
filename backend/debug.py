with open('app/modules/chatbot/conversation/engine.py', 'r') as f:
    lines = f.readlines()
    
# Find lines with 'open invoice'
for i, line in enumerate(lines, 1):
    if 'open invoice' in line.lower():
        # Print 3 lines before and after
        start = max(0, i-3)
        end = min(len(lines), i+3)
        for j in range(start, end):
            print(f'{j+1}: {lines[j]}', end='')
        print('---')