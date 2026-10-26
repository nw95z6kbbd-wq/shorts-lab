"""Preserve tracebacks and expose failures as readable GitHub check annotations."""
import runpy
import sys

try:
    runpy.run_path(sys.argv[1], run_name='__main__')
except Exception as error:
    message=(type(error).__name__+': '+str(error)).replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print('::error title='+sys.argv[1]+'::'+message[:10000],flush=True)
    raise
