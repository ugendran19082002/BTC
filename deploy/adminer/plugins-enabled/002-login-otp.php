<?php
/*
 * A one-time code as well as the password.
 *
 * Adminer on a public name is a database console on the internet; the edge
 * password and the database password are both things that can be phished or
 * reused. The code is not. The secret is ADMINER_OTP_SECRET (base32, the form
 * an authenticator app shows), from deploy/.env -- see docs/ADMINER.md.
 *
 * Fail closed: with no secret the login is refused outright rather than
 * quietly running with one factor fewer.
 */
require_once 'plugins/login-otp.php';

function btc_base32_decode(string $s): string {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $s = strtoupper(preg_replace('/[^A-Za-z2-7]/', '', $s));
    $bits = '';
    foreach (str_split($s) as $c) {
        $bits .= str_pad(decbin(strpos($alphabet, $c)), 5, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 8) as $byte) {
        if (strlen($byte) === 8) $out .= chr(bindec($byte));
    }
    return $out;
}

$secret = getenv('ADMINER_OTP_SECRET') ?: '';
if (strlen(btc_base32_decode($secret)) < 10) {
    class AdminerRefuseWithoutOtp extends Adminer\Plugin {
        function login($login, $password) {
            return 'ADMINER_OTP_SECRET is not set on this server: sign-in is disabled. See docs/ADMINER.md.';
        }
    }
    return new AdminerRefuseWithoutOtp();
}
return new AdminerLoginOtp(btc_base32_decode($secret));
