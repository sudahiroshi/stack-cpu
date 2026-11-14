; 05_sleep_joy.asm — タイマで待ってからジョイパッドを読む（一般モードで動く）
UP_CNTLO  EQU $FF0F0000
UP_CNTHI  EQU $FF0F0004
UP_CMPLO  EQU $FF0F0008
UP_CMPHI  EQU $FF0F000C
UP_JOY    EQU $FF0F0010
EV_TIMER  EQU 4                   ; イベントビット2のマスク

main:   PUSH  #16667      ; ( 16667 )        約1/60秒
        BSR   sleep       ; ( )
        LD    UP_JOY      ; ( joy )
        PUSH  #$10        ; ( joy 16 )       bit4 = Aボタン
        AND               ; ( pressed )
        BNZ   on_a        ; ( )
        BRA   main
on_a:   HALT

; sleep ( us -- )
sleep:  LD    UP_CNTHI    ; ( us h1 )
        LD    UP_CNTLO    ; ( us h1 lo )
        LD    UP_CNTHI    ; ( us h1 lo h2 )
        PSHR              ; ( us h1 lo )      R:( h2 )
        EXG               ; ( us lo h1 )
        PEEKR             ; ( us lo h1 h2 )
        CMPEQ             ; ( us lo same )
        BZ    retry       ; ( us lo )
        PUSH  N           ; ( us lo us )
        ADD               ; ( us sum )
        EXG               ; ( sum us )
        PUSH  N           ; ( sum us sum )
        EXG               ; ( sum sum us )
        CMPLO             ; ( sum carry )
        PULR              ; ( sum carry hi )
        EXG               ; ( sum hi carry )
        SUB               ; ( sum hi' )
        ST    UP_CMPHI    ; ( sum )
        ST    UP_CMPLO    ; ( )
        PUSHQ #EV_TIMER   ; ( 4 )
        WAIT              ; ( bits )
        POP               ; ( )
        RTS
retry:  POP               ; ( us )
        PULR              ; ( us h2 )
        POP               ; ( us )
        BRA   sleep
