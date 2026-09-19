<?php
/*
 * No "Permanent login". A console that stays signed in for a month on whatever
 * browser last used it is the wrong default for a database with orders in it;
 * a session here ends when the browser does.
 */
class AdminerNoPermanentLogin extends Adminer\Plugin {
    function __construct() {
        if (isset($_POST['auth'])) unset($_POST['auth']['permanent']);
    }
    function loginFormField($name, $heading, $value) {
        if ($name == 'permanent') return '';
    }
}
return new AdminerNoPermanentLogin();
