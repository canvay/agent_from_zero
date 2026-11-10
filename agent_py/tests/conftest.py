"""测试前把工作区和状态目录指向临时目录，不碰你的真实文件。"""
import os
import sys
import tempfile

WS = tempfile.mkdtemp(prefix="nami-ws-")
os.environ["NAMI_WORKSPACE"] = WS
os.environ["NAMI_STATE_DIR"] = tempfile.mkdtemp(prefix="nami-state-")
os.environ.setdefault("API_KEY", "test")
os.chdir(WS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))