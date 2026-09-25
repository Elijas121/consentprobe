# Records docs/demo.gif against a local fixture (never a real site): vhs docs/demo.tape
Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 380
Set Padding 20
Set TypingSpeed 60ms
Env PS1 "$ "

Hide
Type "pnpm -s build && clear"
Enter
Sleep 8s
Show

Type "pnpm -s demo"
Sleep 500ms
Enter
Sleep 15s
