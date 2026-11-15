"""Regression for the iOS If editor's variable-picker serialization contract."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('shortcut_builder', ROOT / 'scripts/build-shortcut.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def validate_condition(workflow):
    actions = workflow['WFWorkflowActions']
    index, condition = next((i, a['WFWorkflowActionParameters']) for i, a in enumerate(actions)
                           if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.conditional'
                           and a['WFWorkflowActionParameters']['WFControlFlowMode'] == 0)
    picker = condition['WFInput']
    assert picker.get('Type') == 'Variable', 'If requires a variable-picker wrapper; bare attachments import blank'
    attachment = picker['Variable']
    assert attachment['WFSerializationType'] == 'WFTextTokenAttachment'
    value = attachment['Value']
    assert value['Type'] == 'ActionOutput'
    preceding = actions[index - 1]['WFWorkflowActionParameters']
    assert preceding['WFDictionaryKey'] == 'url'
    assert value['OutputUUID'] == preceding['UUID'], 'Condition must test the upload response URL'
    assert condition['WFCondition'] == 100, 'Test whether a URL exists, without requiring a comparison literal'
    group = condition['GroupingIdentifier']
    markers = [a['WFWorkflowActionParameters'] for a in actions
               if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.conditional'
               and a['WFWorkflowActionParameters']['GroupingIdentifier'] == group]
    assert [p['WFControlFlowMode'] for p in markers] == [0, 1, 2]
    assert all('WFInput' not in p for p in markers[1:])


class ShortcutFormatTest(unittest.TestCase):
    def test_generated_condition_references_upload_url(self):
        validate_condition(builder.build())

    def test_native_opens_app_with_document_id_without_token(self):
        workflow = builder.build(native=True)
        validate_condition(workflow)
        actions = workflow['WFWorkflowActions']
        opener = next(a['WFWorkflowActionParameters']['WFInput']['Value'] for a in actions
                      if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.openurl')
        self.assertEqual(opener['string'], 'modu-reader://open?server=\ufffc&document=\ufffc')
        referenced = {v['OutputUUID'] for v in opener['attachmentsByRange'].values()}
        token_id = actions[1]['WFWorkflowActionParameters']['UUID']
        self.assertNotIn(token_id, referenced)
        doc_action = next(a['WFWorkflowActionParameters'] for a in actions
                          if a['WFWorkflowActionParameters'].get('WFDictionaryKey') == 'doc.id')
        self.assertIn(doc_action['UUID'], referenced)

    def test_rejects_original_blank_condition_encoding(self):
        workflow = builder.build()
        condition = workflow['WFWorkflowActions'][6]['WFWorkflowActionParameters']
        condition['WFInput'] = condition['WFInput']['Variable']
        with self.assertRaisesRegex(AssertionError, 'variable-picker'):
            validate_condition(workflow)


if __name__ == '__main__':
    unittest.main()
