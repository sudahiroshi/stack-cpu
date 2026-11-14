; boot.asm — ブートROM（4KB、$FFFF0000〜$FFFF0FFF）。docs/spec.md 7章・11章を参照。
;
; $FFFF0000  リセット時の入口（全スレッド共通）：TID が 0 なら boot、それ以外は idle
; $FFFF0100  例外ベクタ（VBRのリセット値＋番号×4、番号0〜18）
;            0〜3   スタックのあふれ  → 当面は回復せず、FAULTとして扱う（T-43）
;            4〜7   致命的            → FAULT をカーネルへ送って停止（カーネル自身はモニタへ）
;            8      SYSCALL           → EXIT / DPUTC / DGETC / MONITOR（11.4節）
;            9      BRK               → モニタ
;            10〜17 致命的            → 同上
;            18     未実装命令        → 拡張命令をソフトで実行して RTI（5.2節）
;
; boot：UARTに起動メッセージ、外部RAMの確認（11.2節）、OSの入口（コア0のローカルBSRAMの先頭）へ
; idle：スタックを空にし、RECV で START（UP、PC、PKREAD、PKWRITE）を待つ。送信元が tid 0 でなければ捨てる（11.3節）
;
; 呼び出し規約（13.5節）：各関数の説明に ( スタック効果 ) と深さ D+n R+m を書く。
; 例外のハンドラは、例外を起こしたスレッドのスタックをそのまま使う。

UART_DATA  EQU $FF000000
UART_STAT  EQU $FF000004
GPIO_LED   EQU $FF002004
EXTRAM     EQU $01000000
OS_ENTRY   EQU $00100000          ; OSイメージの入口（T-42）
START_HDR  EQU $00000104          ; START のヘッダ：送信元 tid 0、tag 1、n＝4
RAMERR_LED EQU $2A                ; 外部RAMの検査で食い違ったときのLED（T-95）
MON_AREA   EQU $1000              ; モニタの作業領域：外部RAMの最後の4KB（T-95）

; CSRの番号
RAMSIZE    EQU 6
ECAUSE     EQU 11
EPC        EQU 12
EIR        EQU 13
ESLOT      EQU 14
EADDR      EQU 15
PKREAD     EQU 18
PKWRITE    EQU 19

        ORG   $FFFF0000
reset:  TID
        BZ    boot
        BRA   idle

; ---------------------------------------------------------------- 例外ベクタ
        ORG   $FFFF0100
v0:     BRA   h_dover             ; データスタックのオーバーフロー
v1:     BRA   fault
v2:     BRA   fault
v3:     BRA   fault
v4:     BRA   fault
v5:     BRA   fault
v6:     BRA   fault
v7:     BRA   fault
v8:     BRA   h_syscall
v9:     BRA   monitor             ; BRK
v10:    BRA   fault
v11:    BRA   fault
v12:    BRA   fault
v13:    BRA   fault
v14:    BRA   fault
v15:    BRA   fault               ; 二重例外はハードウェアが止めるので来ない
v16:    BRA   fault               ; 予約
v17:    BRA   fault               ; 予約
v18:    BRA   h_unimpl

; ---------------------------------------------------------------- boot（tid 0）
; boot ( -- )：起動メッセージ、外部RAMの確認、OSの入口へ
boot:   LEA   s_welcome,PC
        BSR   puts
        BSR   ramcheck            ; ( addr status )
        BZ    boot_ok             ; ( addr )
        LEA   s_ramerr,PC
        BSR   puts
        BSR   puthex
        BSR   crlf
        PUSH  #RAMERR_LED
        ST    GPIO_LED
        LEA   boot_halt,PC        ; モニタの「続行」の戻り先（bit0＝1：特権モード）
        ADD   #1
        PSHR
        BRA   monitor
boot_halt: HALT
boot_ok: POP
        PUSH  #OS_ENTRY           ; ヘッダなしのイメージの先頭が入口
        PSHR
        RTS

; ramcheck ( -- addr status )  D+4 R+2
; 外部RAMのデータ線とアドレス線の簡単な検査（11.2節）。成功なら ( 0 0 )、失敗なら ( 番地 −1 )
ramcheck:
        PUSHQ #1                  ; データ線：1のビットを1つずつずらした32通り
rc_d:   PUSH  T
        ST    EXTRAM              ; ( p )
        LD    EXTRAM              ; ( p v )
        PUSH  N
        CMPEQ                     ; ( p f )
        BZ    rc_fd
        PUSHQ #1
        LSL
        PUSH  T
        BNZ   rc_d
        POP
        PUSH  #EXTRAM             ; アドレス線：先頭と、先頭＋2のべき乗（RAMSIZE未満）に番地を書く
        PUSH  T
        ST
        PUSHQ #4                  ; ( off )
rc_w:   PUSH  T
        PUSH  #EXTRAM
        ADD                       ; ( off a )
        PUSH  T
        ST                        ; ( off )   [a] ← a
        PUSHQ #1
        LSL
        PUSH  T
        MFC   RAMSIZE
        CMPLO
        BNZ   rc_w
        POP
        PUSH  #EXTRAM             ; 全部書いてから、まとめて読み戻す
        PUSH  T
        LD
        PUSH  N
        CMPEQ                     ; ( base f )
        BZ    rc_f
        POP
        PUSHQ #4
rc_r:   PUSH  T
        PUSH  #EXTRAM
        ADD                       ; ( off a )
        PUSH  T
        LD
        PUSH  N
        CMPEQ                     ; ( off a f )
        BZ    rc_fa
        POP
        PUSHQ #1
        LSL
        PUSH  T
        MFC   RAMSIZE
        CMPLO
        BNZ   rc_r
        POP
        PUSHQ #0
        PUSHQ #0
        RTS
rc_fd:  POP
        PUSH  #EXTRAM
rc_f:   PUSHQ #-1                 ; ( addr −1 )
        RTS
rc_fa:  EXG
        POP
        PUSHQ #-1
        RTS

; ---------------------------------------------------------------- idle（tid 0 以外）
; idle：START を待ち、指定のUP・PC（bit0＝モード）・PKREAD・PKWRITEで起動する（11.3節）
idle:   PUSHQ #0
        POP   SP
        PUSHQ #0
        POP   RP
id_rx:  RECV                      ; ( h )
        PUSH  T
        PUSH  #START_HDR
        CMPEQ
        BZ    id_skip             ; ( h )
        POP
        RECV
        POP   U
        RECV
        PSHR                      ; PC（bit0＝モード）
        RECV
        MTC   PKREAD
        RECV
        MTC   PKWRITE
        RTI
id_skip: PUSHQ #15                ; カーネル以外からの START や、他のメッセージは本文を捨てる
        AND                       ; ( n )
id_sl:  PUSH  T
        BZ    idle
        RECV
        POP
        ADD   #-1
        BRA   id_sl

; ---------------------------------------------------------------- 例外のハンドラ
; h_dover / fault：再開しない例外（とスタックのあふれ。T-43）。スタックを空にし、
; カーネルに FAULT（例外番号、EPC、EADDR）を送ってスレッドを止める。カーネル自身はモニタへ（7.4節）
h_dover: POP                      ; あふれた直後は一杯のことがあるので、1段空ける
fault:  PUSHQ #0
        POP   SP
        PUSHQ #0
        POP   RP
        TID
        BZ    kfault
        MFC   ECAUSE
        MFC   EPC
        MFC   EADDR
        PUSHQ #3                  ; tag FAULT
        PUSHQ #0                  ; カーネル
        SEND  3
        HALT
kfault: LEA   kf_halt,PC          ; モニタの「続行」の戻り先
        ADD   #1
        PSHR
        BRA   monitor
kf_halt: HALT

; h_syscall ( 引数… n -- 結果… )：SYSCALL（11.4節）。戻り先は次の語
h_syscall:
        PUSH  T
        BZ    sys_exit
        PUSH  T
        PUSHQ #1
        CMPEQ
        BZ    sys_2
        POP                       ; DPUTC ( c -- )
        BSR   putc
        RTI
sys_2:  PUSH  T
        PUSHQ #2
        CMPEQ
        BZ    sys_3
        POP                       ; DGETC ( -- c )
        BSR   getc
        RTI
sys_3:  PUSH  T
        PUSHQ #3
        CMPEQ
        BZ    fault               ; 予約の番号はFAULT（T-96）
        POP                       ; MONITOR ( -- )
        BRA   monitor
sys_exit: POP                     ; EXIT ( code -- )：カーネルに EXITED を送って idle へ
        PUSHQ #2                  ; tag EXITED
        PUSHQ #0
        SEND  1
        BRA   idle

; h_unimpl：例外18。EIR・ESLOTから拡張命令を調べて、ソフトで代わりに実行する（5.2節）
h_unimpl:
        MFC   EIR
        MFC   ESLOT
        ADD   #1                  ; サブ命令の番号は ESLOT の次のスロット
        PUSH  T
        PUSHQ #2
        LSL
        ADD                       ; ( eir 5s )
        PUSH  #27
        EXG
        SUB
        LSR
        PUSH  #31
        AND                       ; ( sub )
        PUSH  T
        PUSH  #19
        CMPEQ
        BZ    hu_1
        POP
        BRA   e_ms
hu_1:   PUSH  T
        PUSH  #21
        CMPEQ
        BZ    hu_2
        POP
        BRA   e_umod
hu_2:   PUSH  T
        PUSH  #22
        CMPEQ
        BZ    hu_3
        POP
        BRA   e_smod
hu_3:   PUSH  T
        PUSH  #23
        CMPEQ
        BZ    hu_4
        POP
        BRA   e_umdm
hu_4:   POP
        BRA   fault

; e_ms：M* ( a b -- lo hi )  D+2 R+1（符号付き：UM* の上位から、負の側の相手を引く）
e_ms:   PUSH  N
        PUSH  N
        PUSHQ #0
        CMPLT
        AND                       ; ( a b cb )  b<0 なら a
        PSHR
        PUSH  N
        PUSH  N
        EXG
        PUSHQ #0
        CMPLT
        AND                       ; ( a b ca )  a<0 なら b
        PULR
        ADD
        PSHR                      ; R:( 補正 )
        MULU
        PULR
        SUB
        RTI

; e_umod：U/MOD ( u1 u2 -- rem quot )  D+2 R+3
e_umod: PUSH  T
        BZ    e_div0
        PUSHQ #0
        EXG
        BSR   ud64
        RTI
e_div0: POP                       ; 0除算：余り＝被除数、商＝全ビット1
        PUSHQ #-1
        RTI

; e_umdm：UM/MOD ( lo hi u -- rem quot )  D+2 R+3
e_umdm: PUSH  N
        PUSH  N
        CMPLO
        BZ    eu_ov
        BSR   ud64
        RTI
eu_ov:  POP                       ; 商があふれる（u＝0を含む）：商＝全ビット1、余り＝0（T-21、T-83）
        POP
        POP
        PUSHQ #0
        PUSHQ #-1
        RTI

; e_smod：/MOD ( n1 n2 -- rem quot )  D+2 R+4（0方向への切り捨て。余りの符号は被除数と同じ）
e_smod: PUSH  T
        BZ    e_div0
        PUSH  N
        PUSH  N
        EOR
        PSHR                      ; R:( 商の符号 )
        PUSH  N
        PSHR                      ; R:( 商の符号 被除数 )
        BSR   abs
        EXG
        BSR   abs
        EXG
        PUSHQ #0
        EXG
        BSR   ud64                ; ( r q )
        EXG
        PULR
        PUSHQ #0
        CMPLT
        BZ    es_1
        BSR   neg
es_1:   EXG
        PULR
        PUSHQ #0
        CMPLT
        BZ    es_2
        BSR   neg
es_2:   RTI

; abs ( n -- |n| )  D+1 R+1 ／ neg ( n -- −n )  D+1 R+1
abs:    PUSH  T
        PUSHQ #0
        CMPLT
        BZ    abs_e
neg:    PUSHQ #0
        EXG
        SUB
abs_e:  RTS

; ud64 ( q rem d -- rem' q' )  D+2 R+4
; 64÷32の符号なし除算（rem:q を d で割る。rem < d であること）。1bitずつ引き戻す方法で32回
ud64:   PUSH  #32
        PSHR
        PSHR                      ; ( q rem ) R:( cnt d )
ud_l:   EXG
        PUSH  T
        PUSH  #31
        LSR                       ; ( rem q b )
        EXG
        PUSHQ #1
        LSL
        EXG                       ; ( rem q' b )
        PSHR                      ; R:( cnt d b )
        EXG                       ; ( q' rem )
        PUSH  T
        PUSH  #31
        LSR                       ; ( q' rem c )  左に出る桁
        PULR
        EXG
        PSHR                      ; ( q' rem b ) R:( cnt d c )
        EXG
        PUSHQ #1
        LSL
        OR                        ; ( q' rem2 )
        PULR                      ; ( q' rem2 c )
        PUSH  N
        PEEKR
        CMPLO
        PUSHQ #-1
        EOR
        OR                        ; ( q' rem2 引く？ )
        BZ    ud_ns
        PEEKR
        SUB
        EXG
        PUSHQ #1
        OR
        EXG
ud_ns:  PULR
        PULR                      ; ( q rem d cnt )
        ADD   #-1
        PUSH  T
        BZ    ud_e
        PSHR
        PSHR
        BRA   ud_l
ud_e:   POP
        POP
        EXG
        RTS

; ---------------------------------------------------------------- UARTの入出力
; putc ( c -- )  D+2 R+1：送信FIFOに空きができるまで待って1文字送る
putc:   LD    UART_STAT
        PUSHQ #2
        AND
        BNZ   putc
        ST    UART_DATA
        RTS

; puts ( addr -- )  D+3 R+2：0で終わる文字列を送る
puts:   PUSH  T
        LDB
        PUSH  T
        BZ    puts_e
        BSR   putc
        ADD   #1
        BRA   puts
puts_e: POP
        POP
        RTS

; crlf ( -- )  D+2 R+2
crlf:   PUSHQ #13
        BSR   putc
        PUSHQ #10
        BSR   putc
        RTS

; puthex ( x -- )  D+3 R+3：16進8桁
puthex: PUSHQ #8
ph_l:   PSHR
        PUSH  T
        PUSH  #28
        LSR
        PUSH  T
        PUSHQ #10
        CMPLO
        BZ    ph_a
        PUSH  #$30
        ADD
        BRA   ph_o
ph_a:   PUSH  #$37
        ADD
ph_o:   BSR   putc
        PUSHQ #4
        LSL
        PULR
        ADD   #-1
        PUSH  T
        BNZ   ph_l
        POP
        POP
        RTS

; getc ( -- c )  D+3 R+1：受信データが来るまで待って1文字受け取る
getc:   PUSH  #16                 ; イベント4（UART受信データあり）
        WAIT
        POP
        LD    UART_DATA
        PUSH  T
        PUSHQ #0
        CMPLT                     ; bit31＝1なら受信データなし
        BZ    gc_e
        POP
        BRA   getc
gc_e:   RTS

; gethex ( -- n )  D+4 R+3：16進数を受け取る（エコーする。CRで終わり。16進以外の文字は無視）
gethex: PUSHQ #0
gh_l:   BSR   getc                ; ( n c )
        PUSH  T
        PUSHQ #13
        CMPEQ
        BNZ   gh_end
        PUSH  T
        BSR   putc
        PUSH  T
        PUSH  #$3A
        CMPLO
        BZ    gh_al
        PUSH  T
        PUSH  #$30
        CMPLO
        BNZ   gh_sk
        PUSH  #$30
        SUB
        BRA   gh_add
gh_al:  PUSH  #$DF
        AND
        PUSH  T
        PUSH  #$41
        CMPLO
        BNZ   gh_sk
        PUSH  T
        PUSH  #$47
        CMPLO
        BZ    gh_sk
        PUSH  #$37
        SUB
gh_add: EXG
        PUSHQ #4
        LSL
        OR
        BRA   gh_l
gh_sk:  POP
        BRA   gh_l
gh_end: POP
        BSR   crlf
        RTS

; ---------------------------------------------------------------- ROMのモニタ（7.4節）
; monitor：データスタックを作業領域に退避し、UARTのコマンドを受け付ける。
; 入るとき、リターンスタックの一番上が「続行」の戻り先（bit0＝モード）。
; コマンド（T-95）：R＝レジスタ、S＝スタック、D 番地＝ダンプ、G＝続行、T＝外部RAMの全域の検査
; 作業領域（外部RAMの最後の4KB）：+0＝退避した深さd、+4×i＝下からi番目の要素（i＝1〜d）
monitor: PUSH SP                  ; ( … d )
        PUSH  T
        BSR   mwa
        ST
mon_sv: PUSH  T
        BZ    mon_svd             ; ( … x d )
        PSHR
        PEEKR
        PUSHQ #2
        LSL
        BSR   mwa
        ADD
        ST                        ; [作業領域＋4d] ← x
        PULR
        ADD   #-1
        BRA   mon_sv
mon_svd: POP                      ; データスタックは空
        LEA   s_mon,PC
        BSR   puts
        TID
        BSR   puthex
        BSR   crlf
        BSR   showregs
mon_cmd: LEA  s_prompt,PC
        BSR   puts
mon_key: BSR  getc                ; ( c )
        PUSH  T
        PUSHQ #13
        CMPEQ
        BNZ   mon_ign
        PUSH  T
        PUSHQ #10
        CMPEQ
        BNZ   mon_ign
        PUSH  T
        PUSH  #32
        CMPEQ
        BNZ   mon_ign
        PUSH  T
        BSR   putc                ; エコー
        PUSH  #$DF
        AND                       ; 英小文字を大文字に
        PUSH  T
        PUSH  #$52                ; R
        CMPEQ
        BZ    mc_s
        POP
        BSR   crlf
        BSR   showregs
        BRA   mon_cmd
mon_ign: POP
        BRA   mon_key
mc_s:   PUSH  T
        PUSH  #$53                ; S
        CMPEQ
        BZ    mc_d
        POP
        BSR   crlf
        BSR   showstack
        BRA   mon_cmd
mc_d:   PUSH  T
        PUSH  #$44                ; D 番地
        CMPEQ
        BZ    mc_g
        POP
        BSR   gethex
        BSR   dump
        BRA   mon_cmd
mc_g:   PUSH  T
        PUSH  #$47                ; G
        CMPEQ
        BZ    mc_t
        POP
        BSR   crlf
        BRA   mon_go
mc_t:   PUSH  T
        PUSH  #$54                ; T
        CMPEQ
        BZ    mc_x
        POP
        BSR   crlf
        BSR   ramfull             ; ( addr status )
        BZ    mt_ok
        LEA   s_ramerr,PC
        BSR   puts
        BSR   puthex
        BSR   crlf
        BRA   mon_cmd
mt_ok:  POP
        LEA   s_ramok,PC
        BSR   puts
        BRA   mon_cmd
mc_x:   POP
        LEA   s_what,PC
        BSR   puts
        BRA   mon_cmd

; mon_go：退避したデータスタックを戻して、続行（RETI）
mon_go: BSR   mwa
        LD                        ; ( d )
        PUSH  T
        BZ    mg_none
        PSHR
        PUSHQ #1
        PSHR                      ; R:( 戻り先 d i )
mg_l:   PEEKR
        PUSHQ #2
        LSL
        BSR   mwa
        ADD
        LD                        ; ( … x )
        PULR
        ADD   #1
        PULR                      ; ( … x i' d )
        PUSH  N
        PUSH  N
        EXG
        CMPLO
        BNZ   mg_end              ; d < i' なら終わり
        PSHR
        PSHR
        BRA   mg_l
mg_end: POP
        POP
        RTI
mg_none: POP
        RTI

; mwa ( -- addr )  D+2 R+1：作業領域の先頭（外部RAMの最後の4KB）
mwa:    MFC   RAMSIZE
        PUSH  #EXTRAM-MON_AREA
        ADD
        RTS

; showregs ( -- )  D+3 R+4：ECAUSE、EPC、EIR、ESLOT、EADDR
showregs:
        LEA   s_ecause,PC
        BSR   puts
        MFC   ECAUSE
        BSR   puthex
        LEA   s_epc,PC
        BSR   puts
        MFC   EPC
        BSR   puthex
        LEA   s_eir,PC
        BSR   puts
        MFC   EIR
        BSR   puthex
        LEA   s_eslot,PC
        BSR   puts
        MFC   ESLOT
        BSR   puthex
        LEA   s_eaddr,PC
        BSR   puts
        MFC   EADDR
        BSR   puthex
        BSR   crlf
        RTS

; showstack ( -- )  D+5 R+4：退避したデータスタック（深さと、下からの要素）
showstack:
        LEA   s_sp,PC
        BSR   puts
        BSR   mwa
        LD                        ; ( d )
        PUSH  T
        BSR   puthex
        BSR   crlf
        PUSHQ #1                  ; ( d i )
ss_l:   PUSH  N
        PUSH  N
        CMPLO
        BNZ   ss_e
        PUSH  T
        PUSHQ #2
        LSL
        BSR   mwa
        ADD
        LD
        BSR   puthex
        PUSH  #32
        BSR   putc
        ADD   #1
        BRA   ss_l
ss_e:   POP
        POP
        BSR   crlf
        RTS

; dump ( addr -- )  D+4 R+5：4語ずつ2行
dump:   PUSHQ #-4
        AND
        PUSHQ #2
du_l:   PSHR                      ; ( a ) R:( 行 )
        PUSH  T
        BSR   puthex
        PUSH  #$3A
        BSR   putc
        PUSHQ #4
du_w:   PSHR                      ; R:( 行 語 )
        PUSH  #32
        BSR   putc
        PUSH  T
        LD
        BSR   puthex
        ADD   #4
        PULR
        ADD   #-1
        PUSH  T
        BNZ   du_w
        POP
        BSR   crlf
        PULR
        ADD   #-1
        PUSH  T
        BNZ   du_l
        POP
        POP
        RTS

; ramfull ( -- addr status )  D+4 R+3：外部RAMの全域の検査（作業領域を除く）。
; 各語に番地を書いて読み戻し、次に番地の反転を書いて読み戻す。成功なら ( 0 0 )、失敗なら ( 番地 −1 )
ramfull: PUSHQ #0                 ; ( inv )  0 → −1
rf_pass: PSHR
        PUSH  #EXTRAM
rf_w:   PUSH  T
        PEEKR
        EOR
        PUSH  N
        ST                        ; [a] ← a xor inv
        ADD   #4
        PUSH  T
        BSR   mwa
        CMPLO
        BNZ   rf_w
        POP
        PUSH  #EXTRAM
rf_r:   PUSH  T
        LD
        PUSH  N
        PEEKR
        EOR
        CMPEQ
        BZ    rf_bad
        ADD   #4
        PUSH  T
        BSR   mwa
        CMPLO
        BNZ   rf_r
        POP
        PULR
        PUSH  T
        BNZ   rf_done
        POP
        PUSHQ #-1
        BRA   rf_pass
rf_done: POP
        PUSHQ #0
        PUSHQ #0
        RTS
rf_bad: PULR
        POP
        PUSHQ #-1
        RTS

; ---------------------------------------------------------------- 文字列
s_welcome: DC.B "Welcome to Stack CPU",13,10,0
s_ramerr:  DC.B "RAM ERROR $",0
s_ramok:   DC.B "RAM OK",13,10,0
s_mon:     DC.B 13,10,"*** MONITOR TID=",0
s_prompt:  DC.B "> ",0
s_what:    DC.B 13,10,"?",13,10,0
s_ecause:  DC.B "ECAUSE=",0
s_epc:     DC.B " EPC=",0
s_eir:     DC.B " EIR=",0
s_eslot:   DC.B " ESLOT=",0
s_eaddr:   DC.B " EADDR=",0
s_sp:      DC.B "SP=",0
