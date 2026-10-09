# Selenium (Python): the snippet from docs/automation.html, checked in CI.
import os, subprocess, sys, time
from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait

ID = 'mhlgmcieamjogdlnfjaoeophmdajkkek'
ext = os.path.abspath('dist-automation')
base = 'http://127.0.0.1:8788'

options = webdriver.ChromeOptions()
options.browser_version = 'stable'  # Chrome for Testing: branded Chrome ignores --load-extension
options.add_argument(f'--load-extension={ext}')
options.add_argument('--headless=new')
driver = webdriver.Chrome(options=options)


def set_headers(query):
    driver.get(f'chrome-extension://{ID}/automation.html?{query}')
    WebDriverWait(driver, 10).until(lambda d: d.execute_script('return document.documentElement.dataset.status'))
    return driver.execute_script('return document.documentElement.dataset.status')


def received(name):
    driver.get(f'{base}/h/{name}')
    return driver.execute_script('return document.body.innerText')


server = subprocess.Popen(['node', '-e', "import('./scripts/automation-smoke/server.mjs').then(m => m.start())"])
time.sleep(1)
failed = False
try:
    for what, got, want in [
        ('page ready', set_headers('X-Test=hello'), 'ready'),
        ('request header sent', received('x-test'), 'hello'),
        ('@clear', set_headers('@clear'), 'ready'),
        ('nothing sent after @clear', received('x-test'), '(none)'),
    ]:
        ok = got == want
        failed |= not ok
        print(f"{'ok  ' if ok else 'FAIL'} selenium-py: {what}" + ('' if ok else f' (got {got!r}, want {want!r})'))
finally:
    driver.quit()
    server.terminate()
sys.exit(1 if failed else 0)
