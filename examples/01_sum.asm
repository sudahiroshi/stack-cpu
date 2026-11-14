; 01_sum.asm — 1+2+…+10 を計算して、ユーザー変数0に入れる（結果は55）
        PUSHQ #0          ; ( 0 )             合計 = 0
        PUSHQ #10         ; ( sum i )         i = 10
loop:   PUSH  T           ; ( sum i i )
        PSHR              ; ( sum i )         R:( i )
        ADD               ; ( sum+i )
        PULR              ; ( sum' i )
        ADD   #-1         ; ( sum' i-1 )
        PUSH  T           ; ( sum' i' i' )
        BNZ   loop        ; ( sum' i' )
        POP               ; ( sum' )
        ST    0,U         ; ( )
        HALT
