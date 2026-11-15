#!/usr/bin/env python3
"""Build the credential-free Apple Shortcut; sign on macOS with --sign.

The HTTP/JSON action shape follows an export from Apple's Shortcuts app.
No account credentials are read by this script. Configuration is entered when
adding the shortcut, not embedded in the public download.
"""
import argparse
import plistlib
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parent.parent

def build(server='https://reader.example.com', token='CONFIGURE_IMPORT_TOKEN', name='用墨读打开'):
    actions = []
    def uid(key):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://github.com/0x7854/modu/shortcut/'+key)).upper()
    def output(key, label):
        return {'Type': 'ActionOutput', 'OutputUUID': uid(key), 'OutputName': label}
    def attachment(value):
        return {'Value': value, 'WFSerializationType': 'WFTextTokenAttachment'}
    def text(*parts):
        string = ''; attachments = {}
        for part in parts:
            if isinstance(part, str):
                string += part
            else:
                offset = len(string.encode('utf-16-le')) // 2
                attachments['{%d, 1}' % offset] = part
                string += '\ufffc'
        value = {'string': string}
        if attachments: value['attachmentsByRange'] = attachments
        return {'Value': value, 'WFSerializationType': 'WFTextTokenString'}
    def dictionary(items):
        return {'Value': {'WFDictionaryFieldValueItems': [
            {'WFKey': text(key), 'WFItemType': 0, 'WFValue': value}
            for key, value in items]}, 'WFSerializationType': 'WFDictionaryFieldValue'}
    def action(identifier, key=None, **params):
        if key: params['UUID'] = uid(key)
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.'+identifier,
                        'WFWorkflowActionParameters': params})
    source = {'Type':'ExtensionInput'}
    action('gettext', 'server', WFTextActionText=server)
    action('gettext', 'token', WFTextActionText=token)
    action('getitemname', 'filename', WFInput=attachment(source))
    action('detect.text', 'markdown', WFInput=attachment(source))
    action('downloadurl', 'upload',
        WFURL=text(output('server','服务网址'), '/api/import/documents'),
        WFHTTPMethod='POST', ShowHeaders=True,
        WFHTTPHeaders=dictionary([
            ('Authorization',text('Bearer ',output('token','仅导入凭证'))),
            ('Content-Type',text('application/json'))]),
        WFJSONValues=dictionary([
            ('name',text(output('filename','名称'))),
            ('markdown',text(output('markdown','文本')))]))
    action('getvalueforkey','url', WFInput=attachment(output('upload','上传结果')),WFDictionaryKey='url')
    group=uid('result-condition')
    # Conditional uses a variable picker, not the bare attachment accepted by
    # ordinary actions. Without this wrapper iOS imports a blank condition.
    action('conditional', WFInput={'Type': 'Variable',
           'Variable': attachment(output('url','阅读地址'))}, WFCondition=100,
           GroupingIdentifier=group, WFControlFlowMode=0)
    action('showresult', Text=text('已加入墨读。\n点开桌面的墨读图标，即可在云文库中阅读。'))
    action('conditional', GroupingIdentifier=group, WFControlFlowMode=1)
    action('getvalueforkey','error',WFInput=attachment(output('upload','上传结果')),WFDictionaryKey='error.message')
    action('showresult',Text=text('导入未完成：',output('error','错误信息'),'\n请检查网址、仅导入凭证和文件格式。'))
    action('conditional', GroupingIdentifier=group, WFControlFlowMode=2)
    questions=[]
    for index,prompt,default in [(0,'填入墨读服务网址（以 https:// 开头，末尾不要带 /）',server),
                                  (1,'粘贴墨读网页「快捷指令」中生成的仅导入凭证；不要填登录密码或 Mac 同步令牌。','')]:
        questions.append({'ActionIndex':index,'ParameterKey':'WFTextActionText',
                          'Text':prompt,'DefaultValue':default,'Category':'Parameter'})
    return {'WFWorkflowName':name,'WFWorkflowClientVersion':'4610',
        'WFWorkflowMinimumClientVersion':900,'WFWorkflowMinimumClientVersionString':'900',
        'WFWorkflowIcon':{'WFWorkflowIconStartColor':1440408063,'WFWorkflowIconGlyphNumber':61440},
        'WFWorkflowActions':actions,'WFWorkflowInputContentItemClasses':['WFGenericFileContentItem'],
        'WFWorkflowTypes':['ActionExtension'],'WFQuickActionSurfaces':[],
        'WFWorkflowHasShortcutInputVariables':True,'WFWorkflowImportQuestions':questions,
        'WFWorkflowOutputContentItemClasses':[],'WFWorkflowHasOutputFallback':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--sign',action='store_true')
    args=parser.parse_args()
    out=ROOT/'.build'/'shortcuts';out.mkdir(parents=True,exist_ok=True)
    unsigned=out/'用墨读打开.shortcut'
    unsigned.write_bytes(plistlib.dumps(build(),fmt=plistlib.FMT_BINARY,sort_keys=False))
    print(unsigned)
    if args.sign:
        signed=ROOT/'cloud'/'public'/'shortcuts'/'Open-in-Modu.shortcut'
        signed.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['shortcuts','sign','--mode','anyone','--input',str(unsigned),'--output',str(signed)],check=True)
        print(signed)
