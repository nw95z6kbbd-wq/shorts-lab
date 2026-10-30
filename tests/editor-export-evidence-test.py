"""Independent VFR color sampling must test held frames, including a lost scene."""
import subprocess,tempfile,unittest
from pathlib import Path
from editor_export_checks import scene_pixels
class ExportEvidence(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.directory=tempfile.TemporaryDirectory();cls.root=Path(cls.directory.name)
  for name,frames in [('complete','eq(n,0)+eq(n,24)+eq(n,48)+eq(n,71)'),('missing-blue','eq(n,0)+eq(n,48)+eq(n,71)')]:
   command=['ffmpeg','-v','error']
   for color in ['red','blue','green']:command+=['-f','lavfi','-i',f'color=c={color}:s=720x1280:r=24:d=1']
   command+=['-filter_complex',f"[0:v][1:v][2:v]concat=n=3:v=1:a=0,select='{frames}'",'-fps_mode','vfr','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y',str(cls.root/(name+'.mp4'))]
   subprocess.run(command,check=True,capture_output=True,timeout=40)
 @classmethod
 def tearDownClass(cls):cls.directory.cleanup()
 def test_samples_the_displayed_frame_rather_than_seeking_to_a_future_scene(self):
  red,blue,green=scene_pixels(self.root/'complete.mp4');self.assertGreater(red[0],red[2]*1.5);self.assertGreater(blue[2],blue[0]*1.5);self.assertGreater(green[1],green[0]*1.5)
 def test_full_duration_and_a_decodable_frame_cannot_hide_a_missing_middle_scene(self):
  red,middle,green=scene_pixels(self.root/'missing-blue.mp4');self.assertGreater(red[0],red[2]*1.5);self.assertGreater(middle[0],middle[2]*1.5);self.assertFalse(middle[2]>middle[0]*1.5);self.assertGreater(green[1],green[0]*1.5)
if __name__=='__main__':unittest.main(verbosity=2)
