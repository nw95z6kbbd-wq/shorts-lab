"""Patch UX regression checks, called for source/standalone in Chromium/WebKit."""
from pathlib import Path
from playwright.sync_api import expect

ROOT=Path(__file__).resolve().parents[1]


def check_patch_ux(page, engine):
    page.wait_for_function('window.ShortsVideoRestored')
    limit=page.evaluate('ShortsVideoCore.IDEA_LIMIT')
    assert page.locator('.studio-navigation .nav-group').count()==2
    expect(page.locator('#studioNavHeading')).to_have_text('Студия')
    expect(page.locator('#aiNavHeading')).to_have_text('Создание с ИИ')
    assert page.locator('.manual-nav [data-view]').count()==3
    assert page.locator('.ai-nav button').count()==1
    expect(page.locator('#ideaModeNote')).to_have_text('Шаблонный режим')
    page.locator('.manual-nav [data-view="script"]').click()
    page.locator('#projectName').fill('Ручной проект сохраняется')
    page.locator('#scriptText').fill('Мой сценарий остаётся в редакторе. Сцены не заменяются.')
    page.locator('#scene-input-0').fill('Самостоятельная правка сцены')
    page.locator('#openVideoMode').click()
    assert page.locator('.manual-nav [aria-current="page"]').count()==0
    expect(page.locator('#openVideoMode')).to_have_attribute('aria-current','page')
    idea=page.locator('#videoIdea')
    for text in ['', 'Привет', 'Привет 🌌', 'Ёж e\u0301 👨‍👩‍👧‍👦']:
        idea.fill(text)
        units=len(text.encode('utf-16-le'))//2
        expect(page.locator('#videoIdeaCounter')).to_have_text(f'{units} / {limit} символов')
    idea.fill('');idea.press_sequentially('История')
    expect(page.locator('#videoIdeaCounter')).to_have_text(f'7 / {limit} символов')
    idea.press('Backspace');expect(page.locator('#videoIdeaCounter')).to_have_text(f'6 / {limit} символов')
    # Insertion in one operation covers paste/IME without losing supplementary characters.
    idea.fill('');idea.focus();page.keyboard.insert_text('Вставка 🌌 без обрезания')
    units=page.evaluate('videoIdea.value.length')
    expect(page.locator('#videoIdeaCounter')).to_have_text(f'{units} / {limit} символов')
    idea.fill('я'*(limit-1))
    expect(page.locator('#videoIdeaCounter')).to_have_attribute('data-state','near')
    idea.fill('я'*limit)
    expect(idea).to_have_attribute('aria-invalid','false')
    expect(page.locator('#videoDraftStatus')).to_have_text('Сохранено на устройстве')
    # Test an overflowing paste, retaining ALL entered text, and the last valid DB state.
    overflow='🌌'*(limit//2+1)
    idea.evaluate('''(e,text)=>{e.value=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));}''',overflow)
    expect(idea).to_have_value(overflow)
    expect(idea).to_have_attribute('aria-invalid','true')
    expect(page.locator('#videoIdeaCounter')).to_have_attribute('data-state','error')
    expect(page.locator('#videoIdeaWarning')).to_contain_text('Лишнее не удалено')
    expect(page.locator('#saveStatus')).to_have_attribute('data-state','warning')
    scenes=page.locator('#videoScenes').inner_text()
    page.locator('#generateIdea').click()
    assert page.locator('#videoScenes').inner_text()==scenes
    assert page.evaluate('async()=>{const r=ShortsProjectDB.createRepository();const p=await r.read("video");r.close();return p.state.idea.length;}')==limit
    page.locator('.manual-nav [data-view="scenes"]').click()
    expect(page.locator('#projectName')).to_have_value('Ручной проект сохраняется')
    expect(page.locator('#scene-input-0')).to_have_value('Самостоятельная правка сцены')
    page.locator('#openVideoMode').click();expect(idea).to_have_value(overflow)
    idea.fill('Идея 🌌 после исправления')
    page.locator('#videoTitle').fill('Видеопроект не теряется')
    expect(page.locator('#videoDraftStatus')).to_have_text('Сохранено на устройстве')
    page.reload();page.wait_for_function('window.ShortsVideoRestored')
    page.locator('#openVideoMode').click()
    expect(idea).to_have_value('Идея 🌌 после исправления')
    expect(page.locator('#videoTitle')).to_have_value('Видеопроект не теряется')
    expect(page.locator('#videoIdeaCounter')).to_have_text(f'{len("Идея 🌌 после исправления".encode("utf-16-le"))//2} / {limit} символов')
    for width,height in ((1440,900),(1024,600),(768,480),(390,844),(320,568),(667,375)):
        page.set_viewport_size({'width':width,'height':height})
        for view in ('script','scenes','subtitles'):
            button=page.locator(f'.manual-nav [data-view="{view}"]')
            button.focus();expect(button).to_be_focused();button.press('Enter')
            expect(page.locator('#scriptStudio')).to_be_visible()
            expect(button).to_have_attribute('aria-current','page')
            assert page.locator('#openVideoMode').get_attribute('aria-current') is None
        page.locator('#openVideoMode').click()
        expect(page.locator('#videoTitle')).to_have_value('Видеопроект не теряется')
        assert page.locator('.manual-nav [aria-current="page"]').count()==0
        assert page.locator('#studioViewport').evaluate('e=>e.scrollWidth<=e.clientWidth'),(width,height)
        page.locator('.product-nav [data-product-open="updates"]').click()
        assert page.locator('#productDialog').evaluate('e=>e.scrollWidth<=e.clientWidth')
        for kind in ('highlight','standard','patch'):
            expect(page.locator(f'.release-{kind}').first).to_be_visible()
        current=page.evaluate('ShortsProduct.releases[0]')
        if current['status']=='unreleased':
            expect(page.locator('.release-item').first.locator('.release-pending')).to_have_text('Ещё не опубликовано')
        else:expect(page.locator('.release-item').first.locator('time')).to_have_attribute('datetime',current['date'])
        # Native dialog focus restoration can precede the queued close event.
        # Wait for the app's close handler before focusing next viewport's nav.
        page.evaluate('window.patchCloseDone=false;document.getElementById("productDialog").addEventListener("close",()=>{window.patchCloseDone=true;},{once:true});')
        page.keyboard.press('Escape')
        page.wait_for_function('window.patchCloseDone')
        expect(page.locator('#productDialog')).to_be_hidden()
        expect(page.locator('.product-nav [data-product-open="updates"]')).to_be_focused()
    # The existing toast/sticky invariance suite remains separate and unchanged.
    page.set_viewport_size({'width':1440,'height':900})
    page.locator('#backToEditor').click()
    expect(page.locator('#scene-input-0')).to_have_value('Самостоятельная правка сцены')
    print(f'PASS [{engine} patch UX]: two navigation groups, keyboard/mode isolation at six sizes, Unicode counter/type/insert/delete/overflow, original valid draft and reload restoration',flush=True)
