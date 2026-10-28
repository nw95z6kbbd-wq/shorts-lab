"""Plain result validation shared by the actual native WebDriver consumer."""
import unittest
from runtime_session_native import command_result

class RuntimeNativeTests(unittest.TestCase):
    def test_failures_never_become_success_even_with_empty_details(self):
        for response in [None,{}, {'failure':{}},{'ok':False,'failure':{}},{'ok':'true'}, {'ok':False,'failure':{'message':'codec failed','stack':'@'}}]:
            with self.subTest(response=response), self.assertRaises(AssertionError):
                command_result(response)
    def test_message_and_phase_are_preserved(self):
        response={'ok':False,'failure':{'message':'audio denied','name':'NotAllowedError','stack':'@'},'runtime':{'trace':{'phase':'recording'}}}
        with self.assertRaises(AssertionError) as error:command_result(response)
        self.assertIn('audio denied',str(error.exception));self.assertIn('recording',str(error.exception))
    def test_false_payload_is_success_only_with_explicit_success_flag(self):
        self.assertIs(command_result({'ok':True,'value':False}),False)
        self.assertEqual(command_result({'ok':True,'value':{'recording':True}}),{'recording':True})

if __name__=='__main__':unittest.main()
