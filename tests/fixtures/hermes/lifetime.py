"""Disposable launcher transport/lifetime canaries; never imports Hermes."""
import ctypes as c
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, sys.argv[1])
from launcher import *
from windows import protected
scratch, python, mode = sys.argv[2:5]
parent = ok(open_process(0x1000, False, os.getpid()))
stamp = creation(parent)
close(parent)
code = "import os,sys,time,subprocess;print('LOW '+str(os.getpid()),flush=True);p=subprocess.Popen([sys.executable,'-I','-S','-B','-c','import time;time.sleep(120)'],creationflags=0x08000000);print('DESC '+str(p.pid),flush=True);time.sleep(120)"
if mode == 'parent':
    child = subprocess.Popen([sys.executable,'-I','-S','-B',str(Path(sys.argv[1])/'launcher.py'),scratch,str(os.getpid()),str(stamp),python,'-I','-B','-c',code],stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stderr,creationflags=0x08000000)
    print('LAUNCHER '+str(child.pid),flush=True)
    time.sleep(120)
elif mode == 'sentinel':
    import msvcrt
    fd = os.open(str(Path(scratch)/'sentinel'),os.O_CREAT|os.O_RDWR)
    os.set_inheritable(fd,True)
    handle = msvcrt.get_osfhandle(fd)
    child_code = "import ctypes as c,sys;sys.path.insert(0,sys.argv[1]);from windows import *;buf=c.create_unicode_buffer(32768);n=final_name(int(sys.argv[2]),buf,len(buf),0);assert not n or not buf.value.endswith('sentinel');print('SENTINEL ABSENT',flush=True)"
    try:
        assert launch(scratch,os.getpid(),stamp,[python,'-I','-B','-c',child_code,sys.argv[1],str(handle)]) == 0
    finally:
        os.close(fd)
elif mode in {'nested','rejected'}:
    assign = bind(k,'AssignProcessToJobObject',[H,H])
    outer = ok(job_new(None,None))
    try:
        limits = Limits()
        limits.basic.flags = 8
        limits.basic.active = 3 if mode == 'nested' else 1  # The selected-venv redirector also owns a process.
        ok(job_set(outer,9,c.byref(limits),c.sizeof(limits)))
        ok(assign(outer,current()))
        try:
            result = launch(scratch,os.getpid(),stamp,[python,'-I','-B','-c',"print('NESTED',flush=True)"])
        except OSError:
            assert mode == 'rejected'
            print('NESTED REFUSED',flush=True)
        else:
            assert mode == 'nested' and result == 0
    finally:
        close(outer)
else:
    raise ValueError('Unknown canary')
