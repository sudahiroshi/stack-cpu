; 06_start.asm — 最小のカーネル（OSイメージとして、ブートROMから tid 0 で入る。docs/spec.md 11章）
; tid 1 に START を送り、一般モードのアプリを起動して、終了（EXITED）を待つ。
; アプリは SYSCALL の DPUTC で文字列を出し、EXIT(7) で終わる。カーネルは "EXIT" を出して、
; 終了コードをスタックに残して止まる。
KEYS     EQU $FF081000            ; コア0のローカルBSRAMの保護キー表
KEY1WX   EQU $61616161            ; キー1、W、X（4ページ分）
APP_UP   EQU $00105000            ; アプリのユーザー領域
EXITED1  EQU $01000201            ; tid 1 からの EXITED（tag 2、n＝1）のヘッダ

; ローカルBSRAMの24ページ（24KB）をキー1・W・Xにする（一般モードのアプリが使えるように）
start:  PUSHQ #6
k_loop: PSHR                      ; ( ) R:( k )
        PUSH  #KEY1WX
        PEEKR
        ADD   #-1
        PUSHQ #2
        LSL
        PUSH  #KEYS
        ADD                       ; ( v addr )
        ST
        PULR
        ADD   #-1
        PUSH  T
        BNZ   k_loop
        POP
; START：UP、PC（bit0＝0：一般モード）、PKREAD、PKWRITE（キー1）
        PUSH  #APP_UP
        LEA   app,PC
        PUSHQ #2
        PUSHQ #2
        PUSHQ #1                  ; tag START
        PUSHQ #1                  ; tid 1
        SEND  4
; 終了を待つ
wait:   RECV                      ; ( h )
        PUSH  #EXITED1
        CMPEQ
        BZ    wait                ; 他のメッセージは無視（本文があれば次のRECVで捨てられる）
        RECV                      ; ( code )
        LEA   s_exit,PC
        BSR   tputs
        HALT

; tputs ( addr -- )  D+4 R+2：0で終わる文字列を SYSCALL の DPUTC で出す（一般モードでも使える）
tputs:  PUSH  T
        LDB
        PUSH  T
        BZ    tp_e
        PUSHQ #1                  ; SYSCALL 1＝DPUTC ( c -- )
        TRAP
        ADD   #1
        BRA   tputs
tp_e:   POP
        POP
        RTS

; アプリ（tid 1、一般モード）
app:    LEA   s_hello,PC
        BSR   tputs
        PUSHQ #7                  ; 終了コード
        PUSHQ #0                  ; SYSCALL 0＝EXIT
        TRAP

s_hello: DC.B "Hello from tid 1",13,10,0
s_exit:  DC.B "EXIT",13,10,0
