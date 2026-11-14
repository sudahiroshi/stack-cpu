; 03_uart_puts.asm — 文字列をUARTに出力する（特権モード）
UART_DATA  EQU $FF000000
UART_STAT  EQU $FF000004
TXFULL     EQU 2                  ; STATUS bit1

start:  LEA   msg,PC      ; ( addr )
        BSR   puts
        HALT

; puts ( addr -- )   0で終わる文字列を送る
puts:   PUSH  T           ; ( a a )
        LDB               ; ( a c )
        PUSH  T           ; ( a c c )
        BZ    done        ; ( a c )
wait:   LD    UART_STAT   ; ( a c st )
        PUSHQ #TXFULL     ; ( a c st 2 )
        AND               ; ( a c full )
        BNZ   wait        ; ( a c )
        ST    UART_DATA   ; ( a )
        ADD   #1          ; ( a+1 )
        BRA   puts
done:   POP               ; ( a )
        POP               ; ( )
        RTS

msg:    DC.B  "Hello, world!",13,10,0
