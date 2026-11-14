; 04_vram_puts.asm — 画面（モード0）に色付きの文字列を書く（特権モード）
VRAM    EQU $FF010000
ATTR    EQU $1E                   ; 背景1、文字色14（色はパレットによる）

start:  LEA   msg,PC                    ; ( s )
        PUSH  #VRAM+(5*80+10)*2         ; ( s vp )   5行目・10桁目
        BSR   vputs
        HALT

; vputs ( str vp -- )
vputs:  PSHR              ; ( s )          R:( vp )
loop:   PUSH  T           ; ( s s )
        LDB               ; ( s c )
        PUSH  T           ; ( s c c )
        BZ    end         ; ( s c )
        PEEKR             ; ( s c vp )
        STB               ; ( s )          文字コード
        PUSH  #ATTR       ; ( s at )
        PEEKR             ; ( s at vp )
        ADD   #1          ; ( s at vp+1 )
        STB               ; ( s )          属性
        PULR              ; ( s vp )
        ADD   #2          ; ( s vp+2 )
        PSHR              ; ( s )          R:( vp+2 )
        ADD   #1          ; ( s+1 )
        BRA   loop
end:    POP               ; ( s )
        POP               ; ( )
        PULR              ; ( vp )
        POP               ; ( )
        RTS

msg:    DC.B  "HELLO",0
