; 02_max.asm — 大きい方を返すサブルーチン
start:  PUSHQ #3          ; ( 3 )
        PUSH  #1000       ; ( 3 1000 )
        BSR   max         ; ( 1000 )
        ST    0,U         ; ( )
        HALT

; max ( a b -- m )   符号付き
max:    PUSH  N           ; ( a b a )
        PUSH  N           ; ( a b a b )
        CMPLT             ; ( a b a<b )
        BZ    keep        ; ( a b )
        EXG               ; ( b a )
keep:   POP               ; ( m )
        RTS
